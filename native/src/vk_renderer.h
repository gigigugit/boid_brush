#pragma once
// Boid Brush — Native Prototype (Phase 1)
// Minimal Vulkan renderer: uploads a CPU pixel buffer to a GPU texture
// and displays it via a fullscreen triangle.

#include <vulkan/vulkan.h>
#include <SDL2/SDL.h>
#include <vector>
#include <cstdint>

class VkRenderer {
public:
    void init(SDL_Window* window, uint32_t canvasWidth, uint32_t canvasHeight);
    void uploadCanvas(const uint8_t* pixels, uint32_t width, uint32_t height);
    void drawFrame();
    void waitIdle();
    void cleanup();

private:
    SDL_Window* window_ = nullptr;

    VkInstance       instance       = VK_NULL_HANDLE;
    VkSurfaceKHR     surface        = VK_NULL_HANDLE;
    VkPhysicalDevice physicalDevice = VK_NULL_HANDLE;
    VkDevice         device         = VK_NULL_HANDLE;
    VkQueue          graphicsQueue  = VK_NULL_HANDLE;
    uint32_t         graphicsFamily = 0;

    VkSwapchainKHR              swapchain = VK_NULL_HANDLE;
    VkFormat                    swapchainFormat{};
    VkExtent2D                  swapchainExtent{};
    std::vector<VkImage>        swapchainImages;
    std::vector<VkImageView>    swapchainImageViews;

    VkRenderPass                renderPass = VK_NULL_HANDLE;
    std::vector<VkFramebuffer>  framebuffers;

    VkDescriptorSetLayout descriptorSetLayout = VK_NULL_HANDLE;
    VkPipelineLayout      pipelineLayout      = VK_NULL_HANDLE;
    VkPipeline            pipeline            = VK_NULL_HANDLE;

    VkImage        canvasImage     = VK_NULL_HANDLE;
    VkDeviceMemory canvasMemory    = VK_NULL_HANDLE;
    VkImageView    canvasImageView = VK_NULL_HANDLE;
    VkSampler      canvasSampler   = VK_NULL_HANDLE;

    VkBuffer       stagingBuffer = VK_NULL_HANDLE;
    VkDeviceMemory stagingMemory = VK_NULL_HANDLE;
    void*          stagingMapped = nullptr;

    VkDescriptorPool descriptorPool = VK_NULL_HANDLE;
    VkDescriptorSet  descriptorSet  = VK_NULL_HANDLE;

    VkCommandPool                commandPool = VK_NULL_HANDLE;
    std::vector<VkCommandBuffer> commandBuffers;

    static constexpr uint32_t MAX_FRAMES_IN_FLIGHT = 2;
    std::vector<VkSemaphore> imageAvailableSems;
    std::vector<VkSemaphore> renderFinishedSems;
    std::vector<VkFence>     inFlightFences;
    uint32_t currentFrame = 0;

    uint32_t canvasWidth_  = 0;
    uint32_t canvasHeight_ = 0;
    bool     canvasInitialized_ = false;

    // Helpers
    uint32_t findMemoryType(uint32_t filter, VkMemoryPropertyFlags props);
    void transitionImageLayout(VkCommandBuffer cmd, VkImage image,
                               VkImageLayout oldL, VkImageLayout newL);
    VkCommandBuffer beginOneTimeCommands();
    void endOneTimeCommands(VkCommandBuffer cmd);
    VkShaderModule createShaderModule(const std::vector<uint32_t>& spirv);
    std::vector<uint32_t> readSPIRV(const char* path);
};
