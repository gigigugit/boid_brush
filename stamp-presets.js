/**
 * Convert inline SVG markup into a compact data URL so stamp presets can be
 * bundled directly in source without separate asset fetches.
 */
function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

export const DEFAULT_STAMP_PRESET_ID = 'builtin-circle';

export const BUILTIN_STAMP_IMAGE_PRESETS = Object.freeze([
  {
    id: 'builtin-circle',
    name: 'Circle',
    sourceType: 'builtin',
    licenseLabel: 'Built-in shape',
    sourceUrl: '',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#0F172A"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-star',
    name: 'Star',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/star.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M10.7881 3.21068C11.2364 2.13274 12.7635 2.13273 13.2118 3.21068L15.2938 8.2164L20.6979 8.64964C21.8616 8.74293 22.3335 10.1952 21.4469 10.9547L17.3295 14.4817L18.5874 19.7551C18.8583 20.8908 17.6229 21.7883 16.6266 21.1798L11.9999 18.3538L7.37329 21.1798C6.37697 21.7883 5.14158 20.8908 5.41246 19.7551L6.67038 14.4817L2.55303 10.9547C1.66639 10.1952 2.13826 8.74293 3.302 8.64964L8.70609 8.2164L10.7881 3.21068Z"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-heart',
    name: 'Heart',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/heart.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" d="M11.645 20.9107L11.6384 20.9072L11.6158 20.8949C11.5965 20.8844 11.5689 20.8693 11.5336 20.8496C11.4629 20.8101 11.3612 20.7524 11.233 20.6769C10.9765 20.5261 10.6132 20.3039 10.1785 20.015C9.31074 19.4381 8.15122 18.5901 6.9886 17.5063C4.68781 15.3615 2.25 12.1751 2.25 8.25C2.25 5.32194 4.7136 3 7.6875 3C9.43638 3 11.0023 3.79909 12 5.0516C12.9977 3.79909 14.5636 3 16.3125 3C19.2864 3 21.75 5.32194 21.75 8.25C21.75 12.1751 19.3122 15.3615 17.0114 17.5063C15.8488 18.5901 14.6893 19.4381 13.8215 20.015C13.3868 20.3039 13.0235 20.5261 12.767 20.6769C12.6388 20.7524 12.5371 20.8101 12.4664 20.8496C12.4311 20.8693 12.4035 20.8844 12.3842 20.8949L12.3616 20.9072L12.355 20.9107L12.3523 20.9121C12.1323 21.0289 11.8677 21.0289 11.6477 20.9121L11.645 20.9107Z"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-cloud',
    name: 'Cloud',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/cloud.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M4.5 9.75C4.5 6.43629 7.18629 3.75 10.5 3.75C13.028 3.75 15.1893 5.31282 16.0733 7.52408C16.2135 7.50816 16.3559 7.5 16.5 7.5C18.5711 7.5 20.25 9.17893 20.25 11.25C20.25 11.4459 20.2349 11.6386 20.2058 11.827C21.5744 12.5981 22.5 14.0653 22.5 15.75C22.5 18.2353 20.4853 20.25 18 20.25H6.75C3.85051 20.25 1.5 17.8995 1.5 15C1.5 12.8968 2.73627 11.084 4.52024 10.2459C4.50683 10.0822 4.5 9.91686 4.5 9.75Z"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-bolt',
    name: 'Bolt',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/bolt.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M14.6152 1.59492C14.9164 1.76287 15.0643 2.1146 14.9736 2.44734L12.9819 9.75H20.25C20.5486 9.75 20.8188 9.92718 20.9378 10.2011C21.0569 10.475 21.0021 10.7934 20.7983 11.0117L10.2983 22.2617C10.063 22.5139 9.68601 22.573 9.38478 22.4051C9.08354 22.2371 8.93567 21.8854 9.02641 21.5527L11.018 14.25H3.74999C3.45134 14.25 3.18115 14.0728 3.06213 13.7989C2.9431 13.525 2.99792 13.2066 3.20169 12.9883L13.7017 1.73826C13.937 1.48613 14.314 1.42698 14.6152 1.59492Z"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-moon',
    name: 'Moon',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/moon.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M9.52839 1.71786C9.74339 1.93286 9.80731 2.2564 9.69021 2.53701C9.2458 3.60204 9 4.77143 9 6.00013C9 10.9707 13.0294 15.0001 18 15.0001C19.2287 15.0001 20.3981 14.7543 21.4631 14.3099C21.7437 14.1928 22.0673 14.2567 22.2823 14.4717C22.4973 14.6867 22.5612 15.0103 22.4441 15.2909C20.8618 19.0828 17.1183 21.7501 12.75 21.7501C6.95101 21.7501 2.25 17.0491 2.25 11.2501C2.25 6.88184 4.91735 3.13829 8.70924 1.55603C8.98985 1.43894 9.31338 1.50286 9.52839 1.71786Z"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-fire',
    name: 'Fire',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/fire.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M12.9633 2.28579C12.8416 2.12249 12.6586 2.01575 12.4565 1.9901C12.2545 1.96446 12.0506 2.02211 11.8919 2.14981C10.0218 3.65463 8.7174 5.83776 8.35322 8.32637C7.69665 7.85041 7.11999 7.27052 6.6476 6.61081C6.51764 6.42933 6.3136 6.31516 6.09095 6.29934C5.8683 6.28353 5.65017 6.36771 5.49587 6.529C3.95047 8.14442 3 10.3368 3 12.7497C3 17.7202 7.02944 21.7497 12 21.7497C16.9706 21.7497 21 17.7202 21 12.7497C21 9.08876 18.8143 5.93999 15.6798 4.53406C14.5706 3.99256 13.6547 3.21284 12.9633 2.28579ZM15.75 14.25C15.75 16.3211 14.0711 18 12 18C9.92893 18 8.25 16.3211 8.25 14.25C8.25 13.8407 8.31559 13.4467 8.43682 13.0779C9.06529 13.5425 9.78769 13.8874 10.5703 14.0787C10.7862 12.6779 11.4866 11.437 12.4949 10.5324C14.3321 10.7746 15.75 12.3467 15.75 14.25Z"/>
      </svg>
    `),
  },
  {
    id: 'heroicons-sparkles',
    name: 'Sparkles',
    sourceType: 'builtin',
    licenseLabel: 'Heroicons · MIT',
    sourceUrl: 'https://github.com/tailwindlabs/heroicons/blob/master/src/24/solid/sparkles.svg',
    dataUrl: svgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M9 4.5C9.33486 4.5 9.62915 4.72198 9.72114 5.04396L10.5343 7.89015C10.8903 9.13593 11.8641 10.1097 13.1099 10.4657L15.956 11.2789C16.278 11.3709 16.5 11.6651 16.5 12C16.5 12.3349 16.278 12.6291 15.956 12.7211L13.1098 13.5343C11.8641 13.8903 10.8903 14.8641 10.5343 16.1099L9.72114 18.956C9.62915 19.278 9.33486 19.5 9 19.5C8.66514 19.5 8.37085 19.278 8.27886 18.956L7.46566 16.1099C7.10972 14.8641 6.13593 13.8903 4.89015 13.5343L2.04396 12.7211C1.72198 12.6291 1.5 12.3349 1.5 12C1.5 11.6651 1.72198 11.3709 2.04396 11.2789L4.89015 10.4657C6.13593 10.1097 7.10972 9.13593 7.46566 7.89015L8.27886 5.04396C8.37085 4.72198 8.66514 4.5 9 4.5Z"/>
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M18 1.5C18.3442 1.5 18.6441 1.73422 18.7276 2.0681L18.9865 3.10356C19.2216 4.04406 19.9559 4.7784 20.8964 5.01353L21.9319 5.27239C22.2658 5.35586 22.5 5.65585 22.5 6C22.5 6.34415 22.2658 6.64414 21.9319 6.72761L20.8964 6.98647C19.9559 7.2216 19.2216 7.95594 18.9865 8.89644L18.7276 9.9319C18.6441 10.2658 18.3442 10.5 18 10.5C17.6558 10.5 17.3559 10.2658 17.2724 9.9319L17.0135 8.89644C16.7784 7.95594 16.0441 7.2216 15.1036 6.98647L14.0681 6.72761C13.7342 6.64414 13.5 6.34415 13.5 6C13.5 5.65585 13.7342 5.35586 14.0681 5.27239L15.1036 5.01353C16.0441 4.7784 16.7784 4.04406 17.0135 3.10356L17.2724 2.0681C17.3559 1.73422 17.6558 1.5 18 1.5Z"/>
        <path fill="#0F172A" fill-rule="evenodd" clip-rule="evenodd" d="M16.5 15C16.8228 15 17.1094 15.2066 17.2115 15.5128L17.6058 16.6956C17.7551 17.1435 18.1065 17.4949 18.5544 17.6442L19.7372 18.0385C20.0434 18.1406 20.25 18.4272 20.25 18.75C20.25 19.0728 20.0434 19.3594 19.7372 19.4615L18.5544 19.8558C18.1065 20.0051 17.7551 20.3565 17.6058 20.8044L17.2115 21.9872C17.1094 22.2934 16.8228 22.5 16.5 22.5C16.1772 22.5 15.8906 22.2934 15.7885 21.9872L15.3942 20.8044C15.2449 20.3565 14.8935 20.0051 14.4456 19.8558L13.2628 19.4615C12.9566 19.3594 12.75 19.0728 12.75 18.75C12.75 18.4272 12.9566 18.1406 13.2628 18.0385L14.4456 17.6442C14.8935 17.4949 15.2449 17.1435 15.3942 16.6956L15.7885 15.5128C15.8906 15.2066 16.1772 15 16.5 15Z"/>
      </svg>
    `),
  },
]);

export function getBuiltinStampPreset(id) {
  return BUILTIN_STAMP_IMAGE_PRESETS.find(preset => preset.id === id) || null;
}
