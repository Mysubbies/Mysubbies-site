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

    const { AutocompleteSuggestion, AutocompleteSessionToken } = await global.google.maps.importLibrary('places');
    if (!AutocompleteSuggestion || !AutocompleteSessionToken) return null;

    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Address suggestions');
    Object.assign(list.style, {
      display: 'none', position: 'absolute', zIndex: '10000', left: '0', right: '0', top: '100%',
      marginTop: '4px', background: '#fff', color: '#14213D', border: '1px solid #E5E2DC',
      borderRadius: '10px', boxShadow: '0 10px 28px rgba(20,33,61,.14)', overflow: 'hidden',
    });
    const container = input.parentElement;
    if (container && global.getComputedStyle(container).position === 'static') container.style.position = 'relative';
    if (container) container.appendChild(list);

    const state = {
      autocomplete: { list }, selection: null, suggestions: [], activeIndex: -1,
      token: new AutocompleteSessionToken(), requestNumber: 0, timer: null,
    };
    attached.set(input, state);

    function closeList() {
      list.style.display = 'none';
      list.innerHTML = '';
      state.suggestions = [];
      state.activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      input.setAttribute('aria-expanded', 'false');
    }

    function setActive(index) {
      const options = Array.from(list.querySelectorAll('[role="option"]'));
      if (!options.length) return;
      state.activeIndex = (index + options.length) % options.length;
      options.forEach((option, optionIndex) => {
        const active = optionIndex === state.activeIndex;
        option.style.background = active ? '#F5F3EF' : '#fff';
        option.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      input.setAttribute('aria-activedescendant', options[state.activeIndex].id);
    }

    async function selectPrediction(prediction) {
      const place = prediction.toPlace();
      await place.fetchFields({ fields: ['id', 'formattedAddress', 'location', 'addressComponents'] });
      const selection = parsePlace(place);
      if (!selection || selection.country.toUpperCase() !== 'AU') return;
      state.selection = selection;
      input.value = selection.formattedAddress;
      input.dataset.addressVerified = 'true';
      state.token = new AutocompleteSessionToken();
      closeList();
      setStatus(statusElement, true);
      input.dispatchEvent(new CustomEvent('mysubbies:address-selected', { bubbles: true, detail: selection }));
      if (typeof settings.onSelect === 'function') settings.onSelect(selection);
    }

    function renderSuggestions(suggestions) {
      closeList();
      state.suggestions = suggestions;
      suggestions.forEach((suggestion, index) => {
        const prediction = suggestion.placePrediction;
        if (!prediction) return;
        const option = document.createElement('div');
        option.id = input.id + '-address-option-' + index;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.textContent = prediction.text.toString();
        Object.assign(option.style, {
          padding: '11px 13px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '14px',
          lineHeight: '1.35', borderBottom: index < suggestions.length - 1 ? '1px solid #EEEAE4' : 'none',
        });
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('mouseenter', () => setActive(index));
        option.addEventListener('click', () => selectPrediction(prediction).catch(error => {
          console.error('Could not verify selected address:', error);
          setStatus(statusElement, false);
        }));
        list.appendChild(option);
      });
      if (list.childElementCount) list.style.display = 'block';
    }

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.addEventListener('input', () => {
      state.selection = null;
      input.dataset.addressVerified = 'false';
      setStatus(statusElement, false);
      clearTimeout(state.timer);
      const query = input.value.trim();
      if (query.length < 3) { closeList(); return; }
      const requestNumber = ++state.requestNumber;
      state.timer = setTimeout(async () => {
        try {
          const result = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: query, includedRegionCodes: ['au'], sessionToken: state.token,
          });
          if (requestNumber !== state.requestNumber) return;
          renderSuggestions((result && result.suggestions) || []);
          input.setAttribute('aria-expanded', list.style.display === 'block' ? 'true' : 'false');
        } catch (error) {
          console.error('Could not load address suggestions:', error);
          closeList();
        }
      }, 220);
    });
    input.addEventListener('keydown', event => {
      if (list.style.display !== 'block') return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(state.activeIndex + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(state.activeIndex - 1); }
      else if (event.key === 'Escape') { closeList(); }
      else if (event.key === 'Enter' && state.activeIndex >= 0) {
        event.preventDefault();
        const suggestion = state.suggestions[state.activeIndex];
        if (suggestion && suggestion.placePrediction) selectPrediction(suggestion.placePrediction).catch(console.error);
      }
    });
    input.addEventListener('blur', () => setTimeout(closeList, 150));
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
