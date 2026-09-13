(function (global) {
  'use strict';

  let loadPromise = null;
  const attached = new WeakMap();

  function component(components, type, shortName) {
    const match = (components || []).find(item => (item.types || []).includes(type));
    if (!match) return '';
    return String(shortName
      ? (match.shortText || match.short_name || '')
      : (match.longText || match.long_name || ''));
  }

  function parsePlace(place) {
    if (!place) return null;
    const location = place.location || (place.geometry && place.geometry.location);
    if (!location) return null;
    const components = place.addressComponents || place.address_components || [];
    const latitude = typeof location.lat === 'function' ? location.lat() : location.lat;
    const longitude = typeof location.lng === 'function' ? location.lng() : location.lng;
    const suburb = component(components, 'locality')
      || component(components, 'postal_town')
      || component(components, 'sublocality_level_1');
    return {
      formattedAddress: String(place.formattedAddress || place.formatted_address || ''),
      placeId: String(place.id || place.place_id || ''),
      latitude: Number(latitude),
      longitude: Number(longitude),
      suburb,
      state: component(components, 'administrative_area_level_1', true),
      postcode: component(components, 'postal_code'),
      country: component(components, 'country', true),
      verified: true,
    };
  }

  function load() {
    if (global.google && global.google.maps && global.google.maps.importLibrary) {
      return global.google.maps.importLibrary('places').then(() => true).catch(() => false);
    }
    if (loadPromise) return loadPromise;
    loadPromise = fetch('/api/geocode-distance?config=places', { credentials: 'same-origin' })
      .then(response => response.ok ? response.json() : { enabled: false })
      .then(config => new Promise(resolve => {
        if (!config.enabled || !config.browserKey) { resolve(false); return; }
        const callbackName = '__mysubbiesGoogleMapsReady';
        const script = document.createElement('script');
        script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(config.browserKey)
          + '&loading=async&callback=' + callbackName;
        script.async = true;
        global[callbackName] = () => {
          delete global[callbackName];
          if (!global.google || !global.google.maps || !global.google.maps.importLibrary) {
            resolve(false);
            return;
          }
          global.google.maps.importLibrary('places').then(() => resolve(true)).catch(() => resolve(false));
        };
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      }))
      .catch(() => false);
    return loadPromise;
  }

  function setStatus(statusElement, verified) {
    if (!statusElement) return;
    statusElement.textContent = verified ? '✓ Address selected and verified' : 'Select an address from the suggestions to verify it.';
    statusElement.style.color = verified ? '#2F7A50' : '#6B7280';
  }

  async function attach(inputOrId, options) {
    const input = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    if (!input) return null;
    if (attached.has(input)) return attached.get(input);
    const settings = options || {};
    const statusElement = settings.statusElement
      || (settings.statusId ? document.getElementById(settings.statusId) : null);
    input.setAttribute('autocomplete', 'street-address');
    setStatus(statusElement, false);
    const loaded = await load();
    if (!loaded) {
      if (statusElement) {
        statusElement.textContent = 'Address suggestions are temporarily unavailable. Enter the complete street address, suburb, state and postcode.';
        statusElement.style.color = '#6B7280';
      }
      return null;
    }
    if (!document.body.contains(input)) return null;

    const { PlaceAutocompleteElement } = await global.google.maps.importLibrary('places');
    if (!PlaceAutocompleteElement) return null;
    const autocomplete = new PlaceAutocompleteElement({
      includedRegionCodes: ['au'],
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    });
    autocomplete.placeholder = input.placeholder || 'Start typing your address';
    autocomplete.style.display = 'block';
    autocomplete.style.width = '100%';
    autocomplete.style.boxSizing = 'border-box';
    if (input.value) autocomplete.value = input.value;
    input.style.display = 'none';
    input.insertAdjacentElement('afterend', autocomplete);

    const state = { autocomplete, selection: null };
    attached.set(input, state);
    autocomplete.addEventListener('input', () => {
      state.selection = null;
      input.value = autocomplete.value || '';
      input.dataset.addressVerified = 'false';
      setStatus(statusElement, false);
    });
    autocomplete.addEventListener('gmp-select', async event => {
      try {
        const place = event.placePrediction.toPlace();
        await place.fetchFields({ fields: ['id', 'formattedAddress', 'location', 'addressComponents'] });
        const selection = parsePlace(place);
        if (!selection || selection.country.toUpperCase() !== 'AU') return;
        state.selection = selection;
        input.value = selection.formattedAddress;
        autocomplete.value = selection.formattedAddress;
        input.dataset.addressVerified = 'true';
        setStatus(statusElement, true);
        input.dispatchEvent(new CustomEvent('mysubbies:address-selected', { bubbles: true, detail: selection }));
        if (typeof settings.onSelect === 'function') settings.onSelect(selection);
      } catch (error) {
        console.error('Could not verify selected address:', error);
        setStatus(statusElement, false);
      }
    });
    return state;
  }

  function getSelection(inputOrId) {
    const input = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
    const state = input && attached.get(input);
    return state ? state.selection : null;
  }

  const api = { attach, getSelection, load, parsePlace };
  global.MySubbiesAddress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
