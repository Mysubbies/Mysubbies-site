(function (global) {
  'use strict';

  let loadPromise = null;
  const attached = new WeakMap();

  function component(components, type, shortName) {
    const match = (components || []).find(item => (item.types || []).includes(type));
    return match ? String(shortName ? match.short_name : match.long_name || '') : '';
  }

  function parsePlace(place) {
    if (!place || !place.geometry || !place.geometry.location) return null;
    const components = place.address_components || [];
    const suburb = component(components, 'locality')
      || component(components, 'postal_town')
      || component(components, 'sublocality_level_1');
    return {
      formattedAddress: String(place.formatted_address || ''),
      placeId: String(place.place_id || ''),
      latitude: place.geometry.location.lat(),
      longitude: place.geometry.location.lng(),
      suburb,
      state: component(components, 'administrative_area_level_1', true),
      postcode: component(components, 'postal_code'),
      country: component(components, 'country', true),
      verified: true,
    };
  }

  function load() {
    if (global.google && global.google.maps && global.google.maps.places) return Promise.resolve(true);
    if (loadPromise) return loadPromise;
    loadPromise = fetch('/api/geocode-distance?config=places', { credentials: 'same-origin' })
      .then(response => response.ok ? response.json() : { enabled: false })
      .then(config => new Promise(resolve => {
        if (!config.enabled || !config.browserKey) { resolve(false); return; }
        const script = document.createElement('script');
        script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(config.browserKey) + '&libraries=places&loading=async';
        script.async = true;
        script.onload = () => resolve(!!(global.google && global.google.maps && global.google.maps.places));
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

    const autocomplete = new global.google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: 'au' },
      fields: ['address_components', 'formatted_address', 'geometry', 'place_id'],
      types: ['address'],
    });
    const state = { autocomplete, selection: null };
    attached.set(input, state);
    input.addEventListener('input', () => {
      state.selection = null;
      input.dataset.addressVerified = 'false';
      setStatus(statusElement, false);
    });
    autocomplete.addListener('place_changed', () => {
      const selection = parsePlace(autocomplete.getPlace());
      if (!selection || selection.country.toUpperCase() !== 'AU') return;
      state.selection = selection;
      input.value = selection.formattedAddress;
      input.dataset.addressVerified = 'true';
      setStatus(statusElement, true);
      input.dispatchEvent(new CustomEvent('mysubbies:address-selected', { bubbles: true, detail: selection }));
      if (typeof settings.onSelect === 'function') settings.onSelect(selection);
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
