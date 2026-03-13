#include "vk_renderer.h"
#include <SDL2/SDL_vulkan.h>

#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#define VK_CHECK(call)                                                        \
    do {                                                                      \
        VkResult _r = (call);                                                 \
        if (_r != VK_SUCCESS) {                                               \
            fprintf(stderr, "Vulkan error %d at %s:%d\n", _r, __FILE__,       \
                    __LINE__);                                                \
            abort();                                                          \
        }                                                                     \
    } while (0)

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

std::vector<uint32_t> VkRenderer::readSPIRV(const char* path) {
    std::ifstream f(path, std::ios::ate | std::ios::binary);
    if (!f.is_open())
        throw std::runtime_error(std::string("Cannot open shader: ") + path);
    size_t sz = static_cast<size_t>(f.tellg());
    std::vector<uint32_t> buf(sz / sizeof(uint32_t));
    f.seekg(0);
    f.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(sz));
    return buf;
}

VkShaderModule VkRenderer::createShaderModule(const std::vector<uint32_t>& code) {
    VkShaderModuleCreateInfo ci{};
    ci.sType    = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    ci.codeSize = code.size() * sizeof(uint32_t);
    ci.pCode    = code.data();
    VkShaderModule sm;
    VK_CHECK(vkCreateShaderModule(device, &ci, nullptr, &sm));
    return sm;
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

uint32_t VkRenderer::findMemoryType(uint32_t filter,
                                    VkMemoryPropertyFlags props) {
    VkPhysicalDeviceMemoryProperties mem;
    vkGetPhysicalDeviceMemoryProperties(physicalDevice, &mem);
    for (uint32_t i = 0; i < mem.memoryTypeCount; i++)
        if ((filter & (1u << i)) &&
            (mem.memoryTypes[i].propertyFlags & props) == props)
            return i;
    throw std::runtime_error("No suitable memory type");
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

VkCommandBuffer VkRenderer::beginOneTimeCommands() {
    VkCommandBufferAllocateInfo ai{};
    ai.sType              = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    ai.commandPool        = commandPool;
    ai.level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    ai.commandBufferCount = 1;
    VkCommandBuffer cmd;
    vkAllocateCommandBuffers(device, &ai, &cmd);

    VkCommandBufferBeginInfo bi{};
    bi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &bi);
    return cmd;
}

void VkRenderer::endOneTimeCommands(VkCommandBuffer cmd) {
    vkEndCommandBuffer(cmd);
    VkSubmitInfo si{};
    si.sType              = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1;
    si.pCommandBuffers    = &cmd;
    vkQueueSubmit(graphicsQueue, 1, &si, VK_NULL_HANDLE);
    vkQueueWaitIdle(graphicsQueue);
    vkFreeCommandBuffers(device, commandPool, 1, &cmd);
}

void VkRenderer::transitionImageLayout(VkCommandBuffer cmd, VkImage image,
                                       VkImageLayout oldL,
                                       VkImageLayout newL) {
    VkImageMemoryBarrier b{};
    b.sType               = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    b.oldLayout           = oldL;
    b.newLayout           = newL;
    b.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.image               = image;
    b.subresourceRange    = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

    VkPipelineStageFlags srcStage, dstStage;

    if (oldL == VK_IMAGE_LAYOUT_UNDEFINED &&
        newL == VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL) {
        b.srcAccessMask = 0;
        b.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
        srcStage = VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT;
        dstStage = VK_PIPELINE_STAGE_TRANSFER_BIT;
    } else if (oldL == VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL &&
               newL == VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL) {
        b.srcAccessMask = VK_ACCESS_SHADER_READ_BIT;
        b.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
        srcStage = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
        dstStage = VK_PIPELINE_STAGE_TRANSFER_BIT;
    } else if (oldL == VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL &&
               newL == VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL) {
        b.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
        b.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
        srcStage = VK_PIPELINE_STAGE_TRANSFER_BIT;
        dstStage = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
    } else {
        throw std::runtime_error("Unsupported layout transition");
    }

    vkCmdPipelineBarrier(cmd, srcStage, dstStage, 0,
                         0, nullptr, 0, nullptr, 1, &b);
}

// ===========================================================================
// Initialization
// ===========================================================================

void VkRenderer::init(SDL_Window* win, uint32_t cw, uint32_t ch) {
    window_       = win;
    canvasWidth_  = cw;
    canvasHeight_ = ch;

    // === 1. Vulkan Instance ================================================

    VkApplicationInfo appInfo{};
    appInfo.sType              = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    appInfo.pApplicationName   = "Boid Brush";
    appInfo.applicationVersion = VK_MAKE_VERSION(0, 1, 0);
    appInfo.pEngineName        = "BoidEngine";
    appInfo.engineVersion      = VK_MAKE_VERSION(0, 1, 0);
    appInfo.apiVersion         = VK_API_VERSION_1_0;

    // Extensions required by SDL2
    unsigned int extCount = 0;
    SDL_Vulkan_GetInstanceExtensions(window_, &extCount, nullptr);
    std::vector<const char*> extensions(extCount);
    SDL_Vulkan_GetInstanceExtensions(window_, &extCount, extensions.data());

    VkInstanceCreateInfo ici{};
    ici.sType                   = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.pApplicationInfo        = &appInfo;
    ici.enabledExtensionCount   = static_cast<uint32_t>(extensions.size());
    ici.ppEnabledExtensionNames = extensions.data();
    VK_CHECK(vkCreateInstance(&ici, nullptr, &instance));

    // === 2. Surface ========================================================

    if (!SDL_Vulkan_CreateSurface(window_, instance, &surface))
        throw std::runtime_error("SDL_Vulkan_CreateSurface failed");

    // === 3. Physical device ================================================

    uint32_t devCount = 0;
    vkEnumeratePhysicalDevices(instance, &devCount, nullptr);
    if (devCount == 0) throw std::runtime_error("No Vulkan GPU found");
    std::vector<VkPhysicalDevice> devs(devCount);
    vkEnumeratePhysicalDevices(instance, &devCount, devs.data());

    // Prefer discrete GPU
    physicalDevice = devs[0];
    for (auto d : devs) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(d, &props);
        if (props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) {
            physicalDevice = d;
            break;
        }
    }
    {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(physicalDevice, &props);
        fprintf(stderr, "Vulkan device: %s\n", props.deviceName);
    }

    // === 4. Queue family (graphics + present) ==============================

    uint32_t qfCount = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, &qfCount, nullptr);
    std::vector<VkQueueFamilyProperties> qfProps(qfCount);
    vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, &qfCount,
                                             qfProps.data());

    graphicsFamily = UINT32_MAX;
    for (uint32_t i = 0; i < qfCount; i++) {
        VkBool32 present = VK_FALSE;
        vkGetPhysicalDeviceSurfaceSupportKHR(physicalDevice, i, surface,
                                             &present);
        if ((qfProps[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) && present) {
            graphicsFamily = i;
            break;
        }
    }
    if (graphicsFamily == UINT32_MAX)
        throw std::runtime_error("No graphics+present queue family");

    // === 5. Logical device =================================================

    float priority = 1.0f;
    VkDeviceQueueCreateInfo qci{};
    qci.sType            = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = graphicsFamily;
    qci.queueCount       = 1;
    qci.pQueuePriorities = &priority;

    const char* devExts[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};

    VkDeviceCreateInfo dci{};
    dci.sType                   = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount    = 1;
    dci.pQueueCreateInfos       = &qci;
    dci.enabledExtensionCount   = 1;
    dci.ppEnabledExtensionNames = devExts;
    VK_CHECK(vkCreateDevice(physicalDevice, &dci, nullptr, &device));
    vkGetDeviceQueue(device, graphicsFamily, 0, &graphicsQueue);

    // === 6. Swapchain ======================================================

    VkSurfaceCapabilitiesKHR surfCaps;
    vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physicalDevice, surface,
                                              &surfCaps);

    uint32_t fmtCount = 0;
    vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice, surface, &fmtCount,
                                         nullptr);
    std::vector<VkSurfaceFormatKHR> fmts(fmtCount);
    vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice, surface, &fmtCount,
                                         fmts.data());

    // Prefer BGRA8 SRGB
    swapchainFormat = fmts[0].format;
    VkColorSpaceKHR colorSpace = fmts[0].colorSpace;
    for (auto& f : fmts) {
        if (f.format == VK_FORMAT_B8G8R8A8_SRGB &&
            f.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) {
            swapchainFormat = f.format;
            colorSpace      = f.colorSpace;
            break;
        }
    }

    swapchainExtent = surfCaps.currentExtent;
    if (swapchainExtent.width == UINT32_MAX) {
        int w, h;
        SDL_Vulkan_GetDrawableSize(window_, &w, &h);
        swapchainExtent.width  = static_cast<uint32_t>(w);
        swapchainExtent.height = static_cast<uint32_t>(h);
    }

    uint32_t imgCount = surfCaps.minImageCount + 1;
    if (surfCaps.maxImageCount > 0 && imgCount > surfCaps.maxImageCount)
        imgCount = surfCaps.maxImageCount;

    VkSwapchainCreateInfoKHR sci{};
    sci.sType            = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR;
    sci.surface          = surface;
    sci.minImageCount    = imgCount;
    sci.imageFormat      = swapchainFormat;
    sci.imageColorSpace  = colorSpace;
    sci.imageExtent      = swapchainExtent;
    sci.imageArrayLayers = 1;
    sci.imageUsage       = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    sci.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    sci.preTransform     = surfCaps.currentTransform;
    sci.compositeAlpha   = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    sci.presentMode      = VK_PRESENT_MODE_FIFO_KHR;
    sci.clipped          = VK_TRUE;
    VK_CHECK(vkCreateSwapchainKHR(device, &sci, nullptr, &swapchain));

    vkGetSwapchainImagesKHR(device, swapchain, &imgCount, nullptr);
    swapchainImages.resize(imgCount);
    vkGetSwapchainImagesKHR(device, swapchain, &imgCount,
                            swapchainImages.data());

    swapchainImageViews.resize(imgCount);
    for (uint32_t i = 0; i < imgCount; i++) {
        VkImageViewCreateInfo ivci{};
        ivci.sType    = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
        ivci.image    = swapchainImages[i];
        ivci.viewType = VK_IMAGE_VIEW_TYPE_2D;
        ivci.format   = swapchainFormat;
        ivci.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        VK_CHECK(vkCreateImageView(device, &ivci, nullptr,
                                   &swapchainImageViews[i]));
    }

    // === 7. Render pass ====================================================

    VkAttachmentDescription att{};
    att.format         = swapchainFormat;
    att.samples        = VK_SAMPLE_COUNT_1_BIT;
    att.loadOp         = VK_ATTACHMENT_LOAD_OP_CLEAR;
    att.storeOp        = VK_ATTACHMENT_STORE_OP_STORE;
    att.stencilLoadOp  = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
    att.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
    att.initialLayout  = VK_IMAGE_LAYOUT_UNDEFINED;
    att.finalLayout    = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;

    VkAttachmentReference ref{};
    ref.attachment = 0;
    ref.layout     = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;

    VkSubpassDescription sub{};
    sub.pipelineBindPoint    = VK_PIPELINE_BIND_POINT_GRAPHICS;
    sub.colorAttachmentCount = 1;
    sub.pColorAttachments    = &ref;

    VkSubpassDependency dep{};
    dep.srcSubpass    = VK_SUBPASS_EXTERNAL;
    dep.dstSubpass    = 0;
    dep.srcStageMask  = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    dep.srcAccessMask = 0;
    dep.dstStageMask  = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    dep.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;

    VkRenderPassCreateInfo rpci{};
    rpci.sType           = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO;
    rpci.attachmentCount = 1;
    rpci.pAttachments    = &att;
    rpci.subpassCount    = 1;
    rpci.pSubpasses      = &sub;
    rpci.dependencyCount = 1;
    rpci.pDependencies   = &dep;
    VK_CHECK(vkCreateRenderPass(device, &rpci, nullptr, &renderPass));

    // === 8. Framebuffers ===================================================

    framebuffers.resize(swapchainImages.size());
    for (size_t i = 0; i < swapchainImages.size(); i++) {
        VkFramebufferCreateInfo fci{};
        fci.sType           = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO;
        fci.renderPass      = renderPass;
        fci.attachmentCount = 1;
        fci.pAttachments    = &swapchainImageViews[i];
        fci.width           = swapchainExtent.width;
        fci.height          = swapchainExtent.height;
        fci.layers          = 1;
        VK_CHECK(vkCreateFramebuffer(device, &fci, nullptr, &framebuffers[i]));
    }

    // === 9. Command pool ===================================================

    VkCommandPoolCreateInfo cpci{};
    cpci.sType            = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    cpci.flags            = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    cpci.queueFamilyIndex = graphicsFamily;
    VK_CHECK(vkCreateCommandPool(device, &cpci, nullptr, &commandPool));

    // === 10. Canvas texture ================================================

    VkImageCreateInfo imgCi{};
    imgCi.sType       = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    imgCi.imageType   = VK_IMAGE_TYPE_2D;
    imgCi.format      = VK_FORMAT_R8G8B8A8_UNORM;
    imgCi.extent      = {canvasWidth_, canvasHeight_, 1};
    imgCi.mipLevels   = 1;
    imgCi.arrayLayers = 1;
    imgCi.samples     = VK_SAMPLE_COUNT_1_BIT;
    imgCi.tiling      = VK_IMAGE_TILING_OPTIMAL;
    imgCi.usage       = VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                        VK_IMAGE_USAGE_SAMPLED_BIT;
    imgCi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VK_CHECK(vkCreateImage(device, &imgCi, nullptr, &canvasImage));

    VkMemoryRequirements memReq;
    vkGetImageMemoryRequirements(device, canvasImage, &memReq);

    VkMemoryAllocateInfo mai{};
    mai.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    mai.allocationSize  = memReq.size;
    mai.memoryTypeIndex = findMemoryType(memReq.memoryTypeBits,
                                         VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    VK_CHECK(vkAllocateMemory(device, &mai, nullptr, &canvasMemory));
    vkBindImageMemory(device, canvasImage, canvasMemory, 0);

    VkImageViewCreateInfo civci{};
    civci.sType    = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
    civci.image    = canvasImage;
    civci.viewType = VK_IMAGE_VIEW_TYPE_2D;
    civci.format   = VK_FORMAT_R8G8B8A8_UNORM;
    civci.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    VK_CHECK(vkCreateImageView(device, &civci, nullptr, &canvasImageView));

    VkSamplerCreateInfo saci{};
    saci.sType        = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
    saci.magFilter    = VK_FILTER_LINEAR;
    saci.minFilter    = VK_FILTER_LINEAR;
    saci.addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    saci.addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    saci.addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
    VK_CHECK(vkCreateSampler(device, &saci, nullptr, &canvasSampler));

    // === 11. Staging buffer ================================================

    VkDeviceSize bufSize = canvasWidth_ * canvasHeight_ * 4;
    VkBufferCreateInfo bci{};
    bci.sType       = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bci.size        = bufSize;
    bci.usage       = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
    bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VK_CHECK(vkCreateBuffer(device, &bci, nullptr, &stagingBuffer));

    VkMemoryRequirements bufReq;
    vkGetBufferMemoryRequirements(device, stagingBuffer, &bufReq);

    VkMemoryAllocateInfo bmai{};
    bmai.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    bmai.allocationSize  = bufReq.size;
    bmai.memoryTypeIndex = findMemoryType(
        bufReq.memoryTypeBits,
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    VK_CHECK(vkAllocateMemory(device, &bmai, nullptr, &stagingMemory));
    vkBindBufferMemory(device, stagingBuffer, stagingMemory, 0);
    vkMapMemory(device, stagingMemory, 0, bufSize, 0, &stagingMapped);

    // Transition canvas image → SHADER_READ_ONLY (initial)
    {
        VkCommandBuffer cmd = beginOneTimeCommands();
        transitionImageLayout(cmd, canvasImage, VK_IMAGE_LAYOUT_UNDEFINED,
                              VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
        // Clear to white via a buffer copy of white pixels
        memset(stagingMapped, 0xFF, bufSize);
        VkBufferImageCopy region{};
        region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
        region.imageExtent      = {canvasWidth_, canvasHeight_, 1};
        vkCmdCopyBufferToImage(cmd, stagingBuffer, canvasImage,
                               VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1,
                               &region);
        transitionImageLayout(cmd, canvasImage,
                              VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                              VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
        endOneTimeCommands(cmd);
        canvasInitialized_ = true;
    }

    // === 12. Descriptor set layout =========================================

    VkDescriptorSetLayoutBinding binding{};
    binding.binding         = 0;
    binding.descriptorType  = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    binding.descriptorCount = 1;
    binding.stageFlags      = VK_SHADER_STAGE_FRAGMENT_BIT;

    VkDescriptorSetLayoutCreateInfo dslci{};
    dslci.sType        = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    dslci.bindingCount = 1;
    dslci.pBindings    = &binding;
    VK_CHECK(vkCreateDescriptorSetLayout(device, &dslci, nullptr,
                                         &descriptorSetLayout));

    // === 13. Descriptor pool + set =========================================

    VkDescriptorPoolSize poolSize{};
    poolSize.type            = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    poolSize.descriptorCount = 1;

    VkDescriptorPoolCreateInfo dpci{};
    dpci.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    dpci.poolSizeCount = 1;
    dpci.pPoolSizes    = &poolSize;
    dpci.maxSets       = 1;
    VK_CHECK(vkCreateDescriptorPool(device, &dpci, nullptr, &descriptorPool));

    VkDescriptorSetAllocateInfo dsai{};
    dsai.sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    dsai.descriptorPool     = descriptorPool;
    dsai.descriptorSetCount = 1;
    dsai.pSetLayouts        = &descriptorSetLayout;
    VK_CHECK(vkAllocateDescriptorSets(device, &dsai, &descriptorSet));

    VkDescriptorImageInfo dii{};
    dii.imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
    dii.imageView   = canvasImageView;
    dii.sampler     = canvasSampler;

    VkWriteDescriptorSet wds{};
    wds.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    wds.dstSet          = descriptorSet;
    wds.dstBinding      = 0;
    wds.descriptorType  = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
    wds.descriptorCount = 1;
    wds.pImageInfo      = &dii;
    vkUpdateDescriptorSets(device, 1, &wds, 0, nullptr);

    // === 14. Pipeline layout ===============================================

    VkPipelineLayoutCreateInfo plci{};
    plci.sType          = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    plci.setLayoutCount = 1;
    plci.pSetLayouts    = &descriptorSetLayout;
    VK_CHECK(vkCreatePipelineLayout(device, &plci, nullptr, &pipelineLayout));

    // === 15. Graphics pipeline =============================================

    auto vertCode = readSPIRV("shaders/fullscreen.vert.spv");
    auto fragCode = readSPIRV("shaders/fullscreen.frag.spv");
    VkShaderModule vertModule = createShaderModule(vertCode);
    VkShaderModule fragModule = createShaderModule(fragCode);

    VkPipelineShaderStageCreateInfo stages[2]{};
    stages[0].sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[0].stage  = VK_SHADER_STAGE_VERTEX_BIT;
    stages[0].module = vertModule;
    stages[0].pName  = "main";
    stages[1].sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[1].stage  = VK_SHADER_STAGE_FRAGMENT_BIT;
    stages[1].module = fragModule;
    stages[1].pName  = "main";

    VkPipelineVertexInputStateCreateInfo vertexInput{};
    vertexInput.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;

    VkPipelineInputAssemblyStateCreateInfo inputAsm{};
    inputAsm.sType    = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO;
    inputAsm.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;

    VkPipelineViewportStateCreateInfo vpState{};
    vpState.sType         = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO;
    vpState.viewportCount = 1;
    vpState.scissorCount  = 1;

    VkPipelineRasterizationStateCreateInfo raster{};
    raster.sType       = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO;
    raster.polygonMode = VK_POLYGON_MODE_FILL;
    raster.cullMode    = VK_CULL_MODE_NONE;
    raster.frontFace   = VK_FRONT_FACE_COUNTER_CLOCKWISE;
    raster.lineWidth   = 1.0f;

    VkPipelineMultisampleStateCreateInfo ms{};
    ms.sType                = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO;
    ms.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;

    VkPipelineColorBlendAttachmentState blendAtt{};
    blendAtt.colorWriteMask = VK_COLOR_COMPONENT_R_BIT |
                              VK_COLOR_COMPONENT_G_BIT |
                              VK_COLOR_COMPONENT_B_BIT |
                              VK_COLOR_COMPONENT_A_BIT;
    blendAtt.blendEnable = VK_FALSE;

    VkPipelineColorBlendStateCreateInfo blend{};
    blend.sType           = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO;
    blend.attachmentCount = 1;
    blend.pAttachments    = &blendAtt;

    VkDynamicState dynStates[] = {VK_DYNAMIC_STATE_VIEWPORT,
                                  VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynState{};
    dynState.sType             = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO;
    dynState.dynamicStateCount = 2;
    dynState.pDynamicStates    = dynStates;

    VkGraphicsPipelineCreateInfo gpci{};
    gpci.sType               = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
    gpci.stageCount          = 2;
    gpci.pStages             = stages;
    gpci.pVertexInputState   = &vertexInput;
    gpci.pInputAssemblyState = &inputAsm;
    gpci.pViewportState      = &vpState;
    gpci.pRasterizationState = &raster;
    gpci.pMultisampleState   = &ms;
    gpci.pColorBlendState    = &blend;
    gpci.pDynamicState       = &dynState;
    gpci.layout              = pipelineLayout;
    gpci.renderPass          = renderPass;
    gpci.subpass             = 0;
    VK_CHECK(vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &gpci,
                                       nullptr, &pipeline));

    vkDestroyShaderModule(device, vertModule, nullptr);
    vkDestroyShaderModule(device, fragModule, nullptr);

    // === 16. Command buffers ===============================================

    commandBuffers.resize(MAX_FRAMES_IN_FLIGHT);
    VkCommandBufferAllocateInfo cbai{};
    cbai.sType              = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    cbai.commandPool        = commandPool;
    cbai.level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cbai.commandBufferCount = MAX_FRAMES_IN_FLIGHT;
    VK_CHECK(vkAllocateCommandBuffers(device, &cbai, commandBuffers.data()));

    // === 17. Sync objects ==================================================

    imageAvailableSems.resize(MAX_FRAMES_IN_FLIGHT);
    renderFinishedSems.resize(MAX_FRAMES_IN_FLIGHT);
    inFlightFences.resize(MAX_FRAMES_IN_FLIGHT);

    VkSemaphoreCreateInfo semCi{};
    semCi.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    VkFenceCreateInfo fenCi{};
    fenCi.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    fenCi.flags = VK_FENCE_CREATE_SIGNALED_BIT;

    for (uint32_t i = 0; i < MAX_FRAMES_IN_FLIGHT; i++) {
        VK_CHECK(vkCreateSemaphore(device, &semCi, nullptr,
                                   &imageAvailableSems[i]));
        VK_CHECK(vkCreateSemaphore(device, &semCi, nullptr,
                                   &renderFinishedSems[i]));
        VK_CHECK(vkCreateFence(device, &fenCi, nullptr, &inFlightFences[i]));
    }
}

// ===========================================================================
// Per-frame
// ===========================================================================

void VkRenderer::uploadCanvas(const uint8_t* pixels, uint32_t w, uint32_t h) {
    memcpy(stagingMapped, pixels, w * h * 4);
}

void VkRenderer::drawFrame() {
    vkWaitForFences(device, 1, &inFlightFences[currentFrame], VK_TRUE,
                    UINT64_MAX);

    uint32_t imageIndex;
    VkResult res = vkAcquireNextImageKHR(
        device, swapchain, UINT64_MAX, imageAvailableSems[currentFrame],
        VK_NULL_HANDLE, &imageIndex);
    if (res == VK_ERROR_OUT_OF_DATE_KHR || res == VK_SUBOPTIMAL_KHR) {
        // Swapchain recreation not implemented in Phase 1 — skip frame.
        return;
    }
    VK_CHECK(res);

    vkResetFences(device, 1, &inFlightFences[currentFrame]);

    VkCommandBuffer cmd = commandBuffers[currentFrame];
    vkResetCommandBuffer(cmd, 0);

    VkCommandBufferBeginInfo beginInfo{};
    beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    VK_CHECK(vkBeginCommandBuffer(cmd, &beginInfo));

    // Upload: staging buffer → canvas texture
    transitionImageLayout(cmd, canvasImage,
                          VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
                          VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);

    VkBufferImageCopy region{};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    region.imageExtent      = {canvasWidth_, canvasHeight_, 1};
    vkCmdCopyBufferToImage(cmd, stagingBuffer, canvasImage,
                           VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);

    transitionImageLayout(cmd, canvasImage,
                          VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                          VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);

    // Render: fullscreen triangle sampling canvas texture
    VkClearValue clear = {{{0.0f, 0.0f, 0.0f, 1.0f}}};
    VkRenderPassBeginInfo rpBegin{};
    rpBegin.sType             = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO;
    rpBegin.renderPass        = renderPass;
    rpBegin.framebuffer       = framebuffers[imageIndex];
    rpBegin.renderArea.extent = swapchainExtent;
    rpBegin.clearValueCount   = 1;
    rpBegin.pClearValues      = &clear;
    vkCmdBeginRenderPass(cmd, &rpBegin, VK_SUBPASS_CONTENTS_INLINE);

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS,
                            pipelineLayout, 0, 1, &descriptorSet, 0, nullptr);

    VkViewport viewport{};
    viewport.width    = static_cast<float>(swapchainExtent.width);
    viewport.height   = static_cast<float>(swapchainExtent.height);
    viewport.maxDepth = 1.0f;
    vkCmdSetViewport(cmd, 0, 1, &viewport);

    VkRect2D scissor{};
    scissor.extent = swapchainExtent;
    vkCmdSetScissor(cmd, 0, 1, &scissor);

    vkCmdDraw(cmd, 3, 1, 0, 0);   // fullscreen triangle

    vkCmdEndRenderPass(cmd);
    VK_CHECK(vkEndCommandBuffer(cmd));

    // Submit
    VkPipelineStageFlags waitStage =
        VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo si{};
    si.sType                = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.waitSemaphoreCount   = 1;
    si.pWaitSemaphores      = &imageAvailableSems[currentFrame];
    si.pWaitDstStageMask    = &waitStage;
    si.commandBufferCount   = 1;
    si.pCommandBuffers      = &cmd;
    si.signalSemaphoreCount = 1;
    si.pSignalSemaphores    = &renderFinishedSems[currentFrame];
    VK_CHECK(vkQueueSubmit(graphicsQueue, 1, &si,
                           inFlightFences[currentFrame]));

    // Present
    VkPresentInfoKHR pi{};
    pi.sType              = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR;
    pi.waitSemaphoreCount = 1;
    pi.pWaitSemaphores    = &renderFinishedSems[currentFrame];
    pi.swapchainCount     = 1;
    pi.pSwapchains        = &swapchain;
    pi.pImageIndices      = &imageIndex;
    vkQueuePresentKHR(graphicsQueue, &pi);

    currentFrame = (currentFrame + 1) % MAX_FRAMES_IN_FLIGHT;
}

// ===========================================================================
// Cleanup
// ===========================================================================

void VkRenderer::waitIdle() { vkDeviceWaitIdle(device); }

void VkRenderer::cleanup() {
    vkDeviceWaitIdle(device);

    for (uint32_t i = 0; i < MAX_FRAMES_IN_FLIGHT; i++) {
        vkDestroySemaphore(device, imageAvailableSems[i], nullptr);
        vkDestroySemaphore(device, renderFinishedSems[i], nullptr);
        vkDestroyFence(device, inFlightFences[i], nullptr);
    }
    vkDestroyCommandPool(device, commandPool, nullptr);

    vkDestroyPipeline(device, pipeline, nullptr);
    vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
    vkDestroyDescriptorPool(device, descriptorPool, nullptr);
    vkDestroyDescriptorSetLayout(device, descriptorSetLayout, nullptr);

    vkDestroySampler(device, canvasSampler, nullptr);
    vkDestroyImageView(device, canvasImageView, nullptr);
    vkDestroyImage(device, canvasImage, nullptr);
    vkFreeMemory(device, canvasMemory, nullptr);

    vkUnmapMemory(device, stagingMemory);
    vkDestroyBuffer(device, stagingBuffer, nullptr);
    vkFreeMemory(device, stagingMemory, nullptr);

    for (auto fb : framebuffers) vkDestroyFramebuffer(device, fb, nullptr);
    vkDestroyRenderPass(device, renderPass, nullptr);
    for (auto iv : swapchainImageViews) vkDestroyImageView(device, iv, nullptr);
    vkDestroySwapchainKHR(device, swapchain, nullptr);

    vkDestroyDevice(device, nullptr);
    vkDestroySurfaceKHR(instance, surface, nullptr);
    vkDestroyInstance(instance, nullptr);
}
