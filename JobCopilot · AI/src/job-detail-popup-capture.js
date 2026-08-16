(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JobDetailPopupCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  // This function is deliberately self-contained because Chrome serializes it
  // into the BOSS page's MAIN world through chrome.scripting.executeScript.
  async function captureJobDetailUrlInPage(options) {
    const root = document.querySelector('.chat-conversation') || document;
    const selectors = [
      '.chat-position-content [ka="geek_chat_job_detail"] .right-content',
      '[ka="geek_chat_job_detail"] .right-content',
      '[ka="geek_chat_job_detail"]',
      '.chat-position-content .position-content > .right-content',
      '.chat-position-content .position-content'
    ];
    const trigger = selectors
      .map(selector => root.querySelector(selector))
      .find(element => element && (element.offsetParent !== null || getComputedStyle(element).position === 'fixed'));
    if (!trigger) return { triggerFound: false, url: '', source: '' };

    const candidateNodes = [
      trigger,
      trigger.closest('[ka="geek_chat_job_detail"]'),
      trigger.closest('.position-content'),
      trigger.closest('.chat-position-content')
    ].filter(Boolean);
    for (const node of candidateNodes) {
      for (const attribute of Array.from(node.attributes || [])) {
        const value = String(attribute.value || '');
        if (value.includes('/job_detail/')) {
          return { triggerFound: true, url: value, source: 'attribute:' + attribute.name };
        }
      }
      const link = node.matches && node.matches('a[href]') ? node : node.querySelector && node.querySelector('a[href]');
      if (link && link.href && link.href.includes('/job_detail/')) {
        return { triggerFound: true, url: link.href, source: 'nested-link' };
      }
    }

    if (!options || options.interceptWindowOpen !== false) {
      let capturedUrl = '';
      let capturedSource = '';
      const originalOpen = window.open;
      let replacedOpen = false;
      const anchorPrototype = typeof HTMLAnchorElement !== 'undefined'
        ? HTMLAnchorElement.prototype
        : null;
      const anchorClickDescriptor = anchorPrototype
        ? Object.getOwnPropertyDescriptor(anchorPrototype, 'click')
        : null;
      const originalAnchorClick = anchorPrototype && anchorPrototype.click;
      let replacedAnchorClick = false;
      const configuredDelay = Number(options && options.captureDelayMs);
      const captureDelayMs = Number.isFinite(configuredDelay)
        ? Math.max(0, Math.min(configuredDelay, 3000))
        : 1200;
      function recordUrl(value, source) {
        const text = String(value || '');
        if (!text) return;
        capturedUrl = text;
        capturedSource = source;
      }
      function captureAnchor(anchor, source) {
        if (!anchor) return false;
        const value = String(
          anchor.href ||
          (anchor.getAttribute && anchor.getAttribute('href')) ||
          ''
        );
        if (!value.includes('/job_detail/')) return false;
        recordUrl(value, source);
        return true;
      }
      function interceptAnchorEvent(event) {
        const target = event && event.target;
        const anchor = target && target.closest ? target.closest('a[href]') : null;
        if (!captureAnchor(anchor, 'anchor-event')) return;
        if (event.preventDefault) event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      }
      try {
        const interceptedOpen = function (url) {
          recordUrl(url, 'window.open');
          let locationHref = String(url || '');
          const interceptedLocation = {
            assign(value) {
              locationHref = String(value || '');
              recordUrl(value, 'window.open.location.assign');
            },
            replace(value) {
              locationHref = String(value || '');
              recordUrl(value, 'window.open.location.replace');
            }
          };
          Object.defineProperty(interceptedLocation, 'href', {
            configurable: true,
            enumerable: true,
            get() { return locationHref; },
            set(value) {
              locationHref = String(value || '');
              recordUrl(value, 'window.open.location.href');
            }
          });
          const interceptedWindow = {
            closed: false,
            focus() {},
            close() {},
            postMessage() {},
            document: {}
          };
          Object.defineProperty(interceptedWindow, 'location', {
            configurable: true,
            enumerable: true,
            get() { return interceptedLocation; },
            set(value) {
              locationHref = String(value || '');
              recordUrl(value, 'window.open.location');
            }
          });
          return interceptedWindow;
        };
        window.open = interceptedOpen;
        replacedOpen = window.open !== originalOpen;
        if (document.addEventListener) {
          document.addEventListener('click', interceptAnchorEvent, true);
        }
        if (anchorPrototype && typeof originalAnchorClick === 'function') {
          anchorPrototype.click = function () {
            if (captureAnchor(this, 'anchor.click')) return;
            return originalAnchorClick.apply(this, arguments);
          };
          replacedAnchorClick = anchorPrototype.click !== originalAnchorClick;
        }
        trigger.click();
        await new Promise(resolve => setTimeout(resolve, captureDelayMs));
      } catch (error) {
        // The targeted active-job component fallback below remains available.
      } finally {
        if (replacedOpen) {
          try { window.open = originalOpen; } catch (error) { /* ignore */ }
        }
        if (document.removeEventListener) {
          document.removeEventListener('click', interceptAnchorEvent, true);
        }
        if (replacedAnchorClick && anchorPrototype) {
          try {
            if (anchorClickDescriptor) {
              Object.defineProperty(anchorPrototype, 'click', anchorClickDescriptor);
            } else {
              delete anchorPrototype.click;
            }
          } catch (error) { /* ignore */ }
        }
      }
      if (capturedUrl) {
        return { triggerFound: true, url: capturedUrl, source: capturedSource || 'window.open' };
      }
    }

    const roots = [];
    for (const node of candidateNodes) {
      if (node.__vue__) {
        roots.push(node.__vue__._data, node.__vue__.$data, node.__vue__.$props);
      }
      if (node.__vueParentComponent) {
        const component = node.__vueParentComponent;
        roots.push(component.props, component.setupState, component.data, component.ctx);
      }
    }
    const seen = new WeakSet();
    let visited = 0;
    let jobId = '';
    function visit(value, depth) {
      if (jobId || !value || typeof value !== 'object' || depth > 6 || visited > 500) return;
      if (seen.has(value)) return;
      seen.add(value);
      visited++;
      for (const key of Object.keys(value)) {
        let child;
        try { child = value[key]; } catch (error) { continue; }
        const keyName = String(key).toLowerCase();
        if (
          (keyName === 'encryptjobid' || keyName === 'jobid' || keyName === 'encryptjobidstr') &&
          typeof child === 'string' &&
          /^[A-Za-z0-9_~.-]{8,}$/.test(child)
        ) {
          jobId = child;
          return;
        }
        if (child && typeof child === 'object' && !(child instanceof Node)) {
          visit(child, depth + 1);
        }
        if (jobId) return;
      }
    }
    roots.filter(Boolean).forEach(rootValue => visit(rootValue, 0));
    return {
      triggerFound: true,
      url: jobId ? (location.origin + '/job_detail/' + encodeURIComponent(jobId) + '.html') : '',
      source: jobId ? 'active-job-component' : ''
    };
  }

  // This is also serialized into the page's MAIN world. Keep it self-contained.
  function clickJobDetailTriggerInPage() {
    const root = document.querySelector('.chat-conversation') || document;
    const selectors = [
      '.chat-position-content [ka="geek_chat_job_detail"] .right-content',
      '[ka="geek_chat_job_detail"] .right-content',
      '[ka="geek_chat_job_detail"]',
      '.chat-position-content .position-content > .right-content',
      '.chat-position-content .position-content'
    ];
    const trigger = selectors
      .map(selector => root.querySelector(selector))
      .find(element => element && (
        element.offsetParent !== null ||
        getComputedStyle(element).position === 'fixed'
      ));
    if (!trigger) return { triggerFound: false, clicked: false };
    trigger.click();
    return { triggerFound: true, clicked: true };
  }

  // Return a verified viewport coordinate for a single browser-level click.
  function getJobDetailClickPointInPage() {
    const root = document.querySelector('.chat-conversation') || document;
    const selectors = [
      '.chat-position-content [ka="geek_chat_job_detail"] .right-content',
      '[ka="geek_chat_job_detail"] .right-content',
      '[ka="geek_chat_job_detail"]',
      '.chat-position-content .position-content > .right-content',
      '.chat-position-content .position-content'
    ];
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      if (!element || typeof element.getBoundingClientRect !== 'function') continue;
      const rect = element.getBoundingClientRect();
      if (
        !rect ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= window.innerHeight ||
        rect.left >= window.innerWidth
      ) continue;
      const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint ? document.elementFromPoint(x, y) : element;
      if (hit && !element.contains(hit) && !hit.contains(element)) continue;
      return {
        triggerFound: true,
        x: x,
        y: y,
        selector: selector,
        text: String(element.textContent || '').trim().slice(0, 80)
      };
    }
    return {
      triggerFound: false,
      x: null,
      y: null,
      selector: '',
      text: ''
    };
  }

  return Object.freeze({
    captureJobDetailUrlInPage: captureJobDetailUrlInPage,
    clickJobDetailTriggerInPage: clickJobDetailTriggerInPage,
    getJobDetailClickPointInPage: getJobDetailClickPointInPage
  });
});
