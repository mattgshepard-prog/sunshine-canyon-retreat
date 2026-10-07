/* ============================================================
   checkout.js — Sunshine Canyon Retreat checkout state machine
   Vanilla JS, no build tools, no imports. Drop-in IIFE.
   Exposes window.checkoutOpen as its only public API.
   ============================================================ */

(function () {
  'use strict';

  /* ----------------------------------------------------------
     Configuration
  ---------------------------------------------------------- */
  // STR Manager direct-booking API (AMS Property Management). Payments go straight to
  // 6186 Sunshine Canyon Dr, LLC's Stripe account; card details never touch our servers.
  const API_BASE = 'https://str-manager-api-production.up.railway.app/direct/sunshine';
  const CONTACT_EMAIL = 'amspropertymgt@gmail.com';
  const FALLBACK_URL = 'mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent('Sunshine Canyon Retreat booking');

  /* ----------------------------------------------------------
     BOOKING KILL SWITCH
     Set to true to disable all booking functionality.
     The calendar and pricing display will still work —
     only the checkout flow is blocked.
     To re-enable: set BOOKING_DISABLED = false
  ---------------------------------------------------------- */
  const BOOKING_DISABLED = false;
  const DISABLED_MESSAGE = 'Online booking is temporarily unavailable. Email us and we will reserve your dates.';
  const DISABLED_CONTACT = CONTACT_EMAIL;

  /* ----------------------------------------------------------
     Internal state
  ---------------------------------------------------------- */
  const state = {
    checkIn: null,           // YYYY-MM-DD
    checkOut: null,          // YYYY-MM-DD
    guests: 2,               // integer
    offer: null,             // private booking link code for THIS checkout, or null (public price)
    quote: null,             // /direct/sunshine/quote response (all amounts in cents)
    config: null,            // /direct/sunshine/config response
    booking: null,           // /direct/sunshine/book response (clientSecret, confirmationCode)
    guest: {                 // from form fields
      firstName: '',
      lastName: '',
      email: '',
      phone: ''
    },
    currentStep: 0,          // 0=closed, 1=step1, 2=step2, 3=step3, 4=step4
    stripeInstance: null,    // Stripe() instance (created in initStripeElements)
    cardElement: null        // Stripe CardElement (mounted to #card-element)
  };

  /* ----------------------------------------------------------
     Private booking link (OFFER-01)
     A link like /?offer=CODE#book opens the checkout on one stay at a price we set for
     that guest. The code is only ever sent to our own API, which decides what it opens:
     the dates, the price and whether the link is still good all come from the server.
     pageOffer is the link this page was opened with, once the server has confirmed it.
  ---------------------------------------------------------- */
  var pageOffer = null;      // { code, checkIn, checkOut, guests } or null

  function offerCodeFromUrl() {
    try {
      var code = new URLSearchParams(window.location.search).get('offer');
      return code ? code.trim() : '';
    } catch (e) {
      return '';
    }
  }

  // The stay fields every quote/book call sends. The offer code rides along only when this
  // checkout was opened from a private link.
  function stayPayload() {
    var payload = { checkIn: state.checkIn, checkOut: state.checkOut, guests: state.guests };
    if (state.offer) payload.offer = state.offer;
    return payload;
  }

  function openPageOffer() {
    window.checkoutOpen({
      checkIn: pageOffer.checkIn,
      checkOut: pageOffer.checkOut,
      guests: pageOffer.guests,
      offer: pageOffer.code
    });
  }

  // A link that opens nothing (used, expired, mistyped): say so in the drawer, with the way
  // to reach us, instead of dropping the guest on the public calendar with no explanation.
  function showOfferProblem(msg) {
    openDrawer();
    goToStep(1);
    el('quote-nights-breakdown').innerHTML = '';
    el('quote-line-items').innerHTML = '';
    el('btn-continue-to-step2').disabled = true;
    showError(msg, FALLBACK_URL);
  }

  function loadPageOffer() {
    var code = offerCodeFromUrl();
    if (!code) return;
    if (BOOKING_DISABLED) {
      showMaintenanceModal();
      return;
    }
    fetch(API_BASE + '/offer/' + encodeURIComponent(code))
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          return { ok: resp.ok, data: data };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.data || !res.data.checkIn || !res.data.checkOut) {
          showOfferProblem(errorText(res.data, 'This booking link could not be opened. Please email us.'));
          return;
        }
        pageOffer = {
          code: code,
          checkIn: res.data.checkIn,
          checkOut: res.data.checkOut,
          guests: res.data.guests || 2
        };
        openPageOffer();
      })
      .catch(function () {
        showOfferProblem('We could not load your booking link. Please check your connection and reload the page.');
      });
  }

  /* ----------------------------------------------------------
     DOM helper
  ---------------------------------------------------------- */
  function el(id) { return document.getElementById(id); }

  /* ----------------------------------------------------------
     ADA: focus trap + focus restore for the checkout drawer.
     - lastFocusedElement is stashed when the drawer opens.
     - When the drawer closes, focus returns there (restores the
       user's place in the page for keyboard and screen-reader users).
     - While the drawer is open, Tab/Shift+Tab wrap within the drawer
       instead of escaping out to the background page.
  ---------------------------------------------------------- */
  var lastFocusedElement = null;

  function getFocusableElements(container) {
    if (!container) return [];
    var selector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    // Filter out elements in hidden steps
    return Array.prototype.slice.call(container.querySelectorAll(selector))
      .filter(function (elem) {
        // Skip elements inside a hidden step
        var step = elem.closest('.checkout-step');
        if (step && step.hasAttribute('hidden')) return false;
        // Skip if element itself hidden or display:none
        if (elem.offsetParent === null && elem.tagName !== 'A') return false;
        return true;
      });
  }

  function handleFocusTrap(e) {
    if (e.key !== 'Tab') return;
    var drawer = el('checkout-drawer');
    if (!drawer || !drawer.classList.contains('is-open')) return;
    var focusables = getFocusableElements(drawer);
    if (focusables.length === 0) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  /* ----------------------------------------------------------
     Spinner — track which buttons spinner disabled
  ---------------------------------------------------------- */
  var spinnerDisabledButtons = new Set();

  function showSpinner(msg) {
    msg = msg || 'Loading...';
    var spinnerEl = el('checkout-spinner');
    spinnerEl.querySelector('.checkout-spinner-text').textContent = msg;
    spinnerEl.classList.add('is-visible');
    spinnerEl.setAttribute('aria-hidden', 'false');
    // Disable all .checkout-btn elements
    var btns = document.querySelectorAll('#checkout-drawer .checkout-btn');
    btns.forEach(function (btn) {
      if (!btn.disabled) {
        btn.disabled = true;
        spinnerDisabledButtons.add(btn.id || btn);
      }
    });
  }

  function hideSpinner() {
    var spinnerEl = el('checkout-spinner');
    spinnerEl.classList.remove('is-visible');
    spinnerEl.setAttribute('aria-hidden', 'true');
    // Re-enable only buttons the spinner disabled (not btn-continue-to-step2 — that's enabled by quote success)
    var btns = document.querySelectorAll('#checkout-drawer .checkout-btn');
    btns.forEach(function (btn) {
      var key = btn.id || btn;
      if (spinnerDisabledButtons.has(key) && btn.id !== 'btn-continue-to-step2') {
        btn.disabled = false;
      }
    });
    spinnerDisabledButtons.clear();
  }

  /* ----------------------------------------------------------
     Error banner
  ---------------------------------------------------------- */
  function showError(msg, fallbackUrl) {
    el('checkout-error-msg').textContent = msg;
    el('checkout-error-fallback').href = fallbackUrl || FALLBACK_URL;
    el('checkout-error').removeAttribute('hidden');
  }

  function hideError() {
    el('checkout-error').setAttribute('hidden', '');
  }

  /* ----------------------------------------------------------
     Open / close drawer
  ---------------------------------------------------------- */
  function openDrawer() {
    // ADA: capture the element that had focus so we can restore it on close
    lastFocusedElement = document.activeElement;
    el('checkout-drawer').classList.add('is-open');
    el('checkout-overlay').classList.add('is-visible');
    document.body.style.overflow = 'hidden';
    el('checkout-drawer').setAttribute('aria-hidden', 'false');
    // ADA: attach focus trap and move focus into the drawer
    document.addEventListener('keydown', handleFocusTrap);
    // Delay focus until step is visible (goToStep runs after openDrawer)
    setTimeout(function () {
      var closeBtn = el('checkout-close-btn');
      if (closeBtn) closeBtn.focus();
    }, 50);
  }

  function resetDrawer() {
    state.currentStep = 0;
    state.quote = null;
    state.guest = { firstName: '', lastName: '', email: '', phone: '' };
    state.booking = null;
    if (state.cardElement) { try { state.cardElement.destroy(); } catch (e) { /* ignore */ } }
    state.cardElement = null;
    // Hide all steps
    [1, 2, 3, 4].forEach(function (n) {
      var step = el('checkout-step-' + n);
      if (step) {
        step.classList.remove('is-active');
        step.setAttribute('hidden', '');
      }
    });
    hideError();
    var spinnerEl = el('checkout-spinner');
    if (spinnerEl) {
      spinnerEl.classList.remove('is-visible');
      spinnerEl.setAttribute('aria-hidden', 'true');
    }
  }

  function closeDrawer() {
    el('checkout-drawer').classList.remove('is-open');
    el('checkout-overlay').classList.remove('is-visible');
    document.body.style.overflow = '';
    el('checkout-drawer').setAttribute('aria-hidden', 'true');
    // ADA: remove focus trap and restore focus to the trigger
    document.removeEventListener('keydown', handleFocusTrap);
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      try { lastFocusedElement.focus(); } catch (e) { /* ignore if element gone */ }
    }
    lastFocusedElement = null;
    // After transition completes, reset state
    setTimeout(function () { resetDrawer(); }, 350);
  }

  /* ----------------------------------------------------------
     Step navigation
  ---------------------------------------------------------- */
  var STEP_TITLES = {
    1: 'Review Your Stay',
    2: 'Your Details',
    3: 'Complete Your Booking',
    4: 'Booking Confirmed!'
  };

  function goToStep(n) {
    // Hide all steps
    [1, 2, 3, 4].forEach(function (i) {
      var step = el('checkout-step-' + i);
      if (step) {
        step.classList.remove('is-active');
        step.setAttribute('hidden', '');
      }
    });
    // Show target step
    var target = el('checkout-step-' + n);
    if (target) {
      target.removeAttribute('hidden');
      target.classList.add('is-active');
    }
    // Update header
    var totalSteps = (n >= 3) ? 4 : 2;
    el('checkout-step-indicator').textContent = 'Step ' + n + ' of ' + totalSteps;
    el('checkout-title').textContent = STEP_TITLES[n] || 'Payment';
    state.currentStep = n;
    // Scroll drawer to top
    el('checkout-drawer').scrollTop = 0;
  }

  /* ----------------------------------------------------------
     Quote fetching and rendering — Step 1
  ---------------------------------------------------------- */
  function formatMoney(amount) {
    return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function formatCents(cents) {
    var dollars = (cents || 0) / 100;
    var whole = Math.round(dollars * 100) % 100 === 0;
    return '$' + dollars.toLocaleString('en-US', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function formatDay(ds, opts) {
    return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts))
      .format(new Date(ds + 'T00:00:00Z'));
  }

  function paymentSentence(q) {
    if (q.balanceCents > 0) {
      return formatCents(q.dueTodayCents) + ' deposit today. The remaining ' + formatCents(q.balanceCents) +
        ' is charged automatically to the same card on ' + formatDay(q.balanceDueOn, { month: 'long', day: 'numeric', year: 'numeric' }) + '.';
    }
    return 'The full ' + formatCents(q.totalCents) + ' is charged today (your stay starts within 14 days).';
  }

  function renderStep1() {
    var q = state.quote;
    if (!q) {
      showError('Unable to load quote details.', FALLBACK_URL);
      return;
    }

    var nightsHtml = '';
    (q.nights || []).forEach(function (n) {
      nightsHtml += '<div class="quote-night-row"><span>' + formatDay(n.date, { weekday: 'short', month: 'short', day: 'numeric' }) +
        '</span><span>' + formatCents(n.directCents) + '</span></div>';
    });
    el('quote-nights-breakdown').innerHTML = nightsHtml;

    var nightCount = q.nightCount;
    var lineHtml = '';
    // A private link carries its own price, so there is no book-direct percentage to quote.
    var nightsNote = q.offer ? ' (your private rate)' : ' (includes ' + escapeHtml(q.directDiscountPct) + '% book-direct discount)';
    lineHtml += '<div class="quote-line"><span>' + nightCount + ' night' + (nightCount !== 1 ? 's' : '') +
      nightsNote + '</span><span>' + formatCents(q.directNightsCents) + '</span></div>';
    lineHtml += '<div class="quote-line"><span>Cleaning fee</span><span>' + formatCents(q.cleaningCents) + '</span></div>';
    lineHtml += '<div class="quote-line"><span>Lodging taxes (' + escapeHtml(q.taxRate) + '%)</span><span>' + formatCents(q.taxCents) + '</span></div>';
    lineHtml += '<div class="quote-line is-total"><span>Total</span><span>' + formatCents(q.totalCents) + '</span></div>';
    if (q.savingsVsOtaCents > 0) {
      lineHtml += '<div class="quote-line quote-savings"><span>You save vs. the same stay on Airbnb</span><span>' + formatCents(q.savingsVsOtaCents) + '</span></div>';
    }
    el('quote-line-items').innerHTML = lineHtml;

    el('checkout-deposit-text').textContent = paymentSentence(q);
    var policy = document.querySelector('#checkout-step-1 .checkout-policy-text');
    if (policy && q.cancellationPolicy) policy.textContent = q.cancellationPolicy;
  }

  function apiPost(path, payload) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        return { ok: resp.ok, status: resp.status, data: data };
      });
    });
  }

  function errorText(data, fallback) {
    return (data && data.error) ? data.error : fallback;
  }

  function fetchQuote() {
    apiPost('/quote', stayPayload())
      .then(function (res) {
        hideSpinner();
        if (!res.ok) {
          showError(errorText(res.data, 'Unable to load pricing. Please try again.'), FALLBACK_URL);
          return;
        }
        state.quote = res.data;
        renderStep1();
        el('btn-continue-to-step2').disabled = false;
      })
      .catch(function () {
        hideSpinner();
        showError('Connection error. Please check your internet and try again.', FALLBACK_URL);
      });
  }

  /* ----------------------------------------------------------
     Maintenance Modal (shown when BOOKING_DISABLED = true)
  ---------------------------------------------------------- */
  function showMaintenanceModal() {
    // Remove existing modal if any
    var existing = document.getElementById('maintenance-modal-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'maintenance-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';

    var modal = document.createElement('div');
    modal.style.cssText = 'background:#1a1a1a;border:1px solid #c9a96e;border-radius:12px;padding:40px 32px;max-width:440px;width:100%;text-align:center;font-family:DM Sans,sans-serif;';

    modal.innerHTML = ''
      + '<div style="font-size:40px;margin-bottom:16px;">&#128295;</div>'
      + '<h3 style="color:#f0ead6;font-family:Cormorant Garamond,serif;font-size:22px;margin:0 0 12px;">Booking Temporarily Unavailable</h3>'
      + '<p style="color:#a8a090;font-size:14px;line-height:1.6;margin:0 0 20px;">' + DISABLED_MESSAGE + '</p>'
      + '<a href="mailto:' + DISABLED_CONTACT + '" style="display:inline-block;background:#c9a96e;color:#1a1a1a;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;margin-bottom:12px;">Contact Us to Book</a>'
      + '<br>'
      + '<button id="maintenance-modal-close" style="background:none;border:1px solid #44403c;color:#a8a090;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;margin-top:8px;">Close</button>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close handlers
    document.getElementById('maintenance-modal-close').addEventListener('click', function () {
      overlay.remove();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', handler);
      }
    });
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  window.checkoutOpen = async function ({ checkIn, checkOut, guests = 2, offer = null }) {
    // BOOKING KILL SWITCH — show maintenance modal
    if (BOOKING_DISABLED) {
      showMaintenanceModal();
      return;
    }
    // Validate params
    if (!checkIn || typeof checkIn !== 'string' || !checkOut || typeof checkOut !== 'string') {
      console.error('checkoutOpen: checkIn and checkOut must be non-empty strings');
      return;
    }
    state.checkIn = checkIn;
    state.checkOut = checkOut;
    state.guests = guests;
    // Set on every open, so a checkout started from the public calendar never carries a
    // private link's code, and the reverse.
    state.offer = offer || null;

    openDrawer();
    goToStep(1);
    showSpinner('Fetching your quote...');
    hideError();
    el('btn-continue-to-step2').disabled = true;
    fetchQuote();
  };

  /* ----------------------------------------------------------
     Step 2: Upsells + Form Validation
  ---------------------------------------------------------- */

  function enterStep2() {
    goToStep(2);
    var upsellSection = el('checkout-upsells');
    if (upsellSection) upsellSection.style.display = 'none';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ----------------------------------------------------------
     Step 3 — Stripe Elements initialization
  ---------------------------------------------------------- */
  function initStripeElements(publishableKey) {
    el('stripe-elements-form').removeAttribute('hidden');
    el('checkout-payment-fallback').setAttribute('hidden', '');

    el('co-charge-notice').textContent = paymentSentence(state.quote);
    var policyLabel = document.querySelector('label[for="co-policy-checkbox"]');
    if (policyLabel && state.quote.cancellationPolicy) {
      policyLabel.textContent = 'I agree to the cancellation policy: ' + state.quote.cancellationPolicy +
        (state.quote.balanceCents > 0 ? ' I authorize the balance to be charged to this card on its due date.' : '');
    }

    if (!state.stripeInstance) state.stripeInstance = Stripe(publishableKey);
    var elements = state.stripeInstance.elements();
    var cardStyle = {
      base: {
        color: '#f0ead6',
        fontSize: '16px',
        fontFamily: 'inherit',
        '::placeholder': { color: '#a8a090' },
        iconColor: '#c9a96e'
      },
      invalid: { color: '#e07070', iconColor: '#e07070' }
    };
    if (state.cardElement) { try { state.cardElement.destroy(); } catch (e) { /* ignore */ } }
    state.cardElement = elements.create('card', { style: cardStyle });
    state.cardElement.mount('#card-element');

    state.cardElement.on('change', function (event) {
      var errorDiv = el('card-errors');
      if (event.error) {
        errorDiv.textContent = event.error.message;
        errorDiv.removeAttribute('hidden');
      } else {
        errorDiv.textContent = '';
        errorDiv.setAttribute('hidden', '');
      }
    });

    var policyCheckbox = el('co-policy-checkbox');
    var confirmBtn = el('co-confirm-btn');
    confirmBtn.disabled = true;
    policyCheckbox.checked = false;
    policyCheckbox.onchange = function () { confirmBtn.disabled = !policyCheckbox.checked; };
  }

  function showCardError(msg) {
    var errorDiv = el('card-errors');
    errorDiv.textContent = msg;
    errorDiv.removeAttribute('hidden');
    el('co-confirm-btn').disabled = !el('co-policy-checkbox').checked;
  }

  /* Step 3 submit: hold the dates (POST /book), then confirm the card with Stripe directly.
     A declined card keeps the same booking + PaymentIntent so the guest can retry with another
     card without losing the dates. */
  function submitPayment() {
    if (!state.stripeInstance || !state.cardElement) {
      showError('Payment form not ready. Please try again.', FALLBACK_URL);
      return;
    }
    hideError();
    el('co-confirm-btn').disabled = true;

    var ready = state.booking ? Promise.resolve(state.booking) : startBooking();
    ready.then(function (booking) {
      if (!booking) return;
      showSpinner('Processing payment...');
      return state.stripeInstance.confirmCardPayment(booking.clientSecret, {
        payment_method: {
          card: state.cardElement,
          billing_details: {
            name: state.guest.firstName + ' ' + state.guest.lastName,
            email: state.guest.email,
            phone: state.guest.phone
          }
        }
      }).then(function (result) {
        hideSpinner();
        if (result.error) {
          showCardError(result.error.message || 'Your card was declined. Please try another card.');
          return;
        }
        var status = result.paymentIntent && result.paymentIntent.status;
        if (status === 'succeeded' || status === 'processing') {
          // The link is single use and has just been used: the page goes back to normal.
          if (state.offer) pageOffer = null;
          renderStep4(booking);
          goToStep(4);
        } else {
          showCardError('Your payment needs another step. Please try again or use a different card.');
        }
      });
    }).catch(function () {
      hideSpinner();
      showError('Connection error during booking. Your card was not charged. Please try again.', FALLBACK_URL);
      el('co-confirm-btn').disabled = !el('co-policy-checkbox').checked;
    });
  }

  function startBooking() {
    showSpinner('Holding your dates...');
    var payload = stayPayload();
    payload.guest = state.guest;
    payload.expectedTotalCents = state.quote.totalCents;
    payload.agreeToPolicy = el('co-policy-checkbox').checked;
    return apiPost('/book', payload).then(function (res) {
      hideSpinner();
      if (res.ok) {
        state.booking = res.data;
        return res.data;
      }
      var code = res.data && res.data.code;
      if (code === 'PRICE_CHANGED' && res.data.quote) {
        state.quote = res.data.quote;
        renderStep1();
        goToStep(1);
        showError(errorText(res.data, 'The price changed. Please review the new total.'), FALLBACK_URL);
        return null;
      }
      if (code === 'BAD_GUEST') {
        goToStep(2);
      }
      showError(errorText(res.data, 'We could not start your booking. Please try again or email us.'), FALLBACK_URL);
      el('co-confirm-btn').disabled = !el('co-policy-checkbox').checked;
      return null;
    });
  }

  function renderStep4(booking) {
    el('co-confirmation-code').textContent = booking.confirmationCode || '—';
    el('co-confirmation-email-notice').textContent =
      'Your payment receipt is on its way to ' + state.guest.email +
      '. We will follow up by email with check-in details before your stay.';

    var detailsHtml = '';
    detailsHtml += '<div><strong>Property:</strong> Sunshine Canyon Retreat</div>';
    detailsHtml += '<div><strong>Guest:</strong> ' + escapeHtml(state.guest.firstName) + ' ' + escapeHtml(state.guest.lastName) + '</div>';
    detailsHtml += '<div><strong>Check-in:</strong> ' + formatDay(state.checkIn, { month: 'long', day: 'numeric', year: 'numeric' }) + '</div>';
    detailsHtml += '<div><strong>Check-out:</strong> ' + formatDay(state.checkOut, { month: 'long', day: 'numeric', year: 'numeric' }) + '</div>';
    detailsHtml += '<div><strong>Paid today:</strong> ' + formatCents(booking.dueTodayCents) + '</div>';
    if (booking.balanceCents > 0) {
      detailsHtml += '<div><strong>Balance:</strong> ' + formatCents(booking.balanceCents) + ' on ' +
        formatDay(booking.balanceDueOn, { month: 'long', day: 'numeric', year: 'numeric' }) + '</div>';
    }
    el('co-confirmation-details').innerHTML = detailsHtml;
    el('co-confirmation-upsells').setAttribute('hidden', '');
    el('co-confirmation-total').textContent = 'Total: ' + formatCents(booking.totalCents);
    if (booking.mode === 'test') {
      el('co-confirmation-total').textContent += ' (TEST MODE: no real charge)';
    }
  }

  /* ----------------------------------------------------------
     Form validation
  ---------------------------------------------------------- */
  function validateField(fieldId, errorId, validatorFn) {
    var input = el(fieldId);
    var val = input.value.trim();
    var errorMsg = validatorFn(val);
    if (errorMsg) {
      input.classList.add('has-error');
      // ADA: expose invalid state to assistive tech
      input.setAttribute('aria-invalid', 'true');
      el(errorId).textContent = errorMsg;
      el(errorId).removeAttribute('hidden');
      return false;
    }
    input.classList.remove('has-error');
    input.setAttribute('aria-invalid', 'false');
    el(errorId).setAttribute('hidden', '');
    return true;
  }

  function validateRequired(val) {
    return val.length < 1 ? 'This field is required.' : null;
  }

  function validateEmail(val) {
    if (!val) return 'Email is required.';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) ? null : 'Please enter a valid email address.';
  }

  function validatePhone(val) {
    if (!val) return 'Phone is required.';
    var digits = val.replace(/\D/g, '');
    return digits.length >= 10 ? null : 'Please enter a valid phone number (10+ digits).';
  }

  function validateGuestForm() {
    var v1 = validateField('field-first-name', 'err-first-name', validateRequired);
    var v2 = validateField('field-last-name', 'err-last-name', validateRequired);
    var v3 = validateField('field-email', 'err-email', validateEmail);
    var v4 = validateField('field-phone', 'err-phone', validatePhone);
    return v1 && v2 && v3 && v4;
  }

  function handleGuestFormSubmit(event) {
    event.preventDefault();
    if (!validateGuestForm()) {
      // Focus first invalid field
      var firstInvalid = el('checkout-guest-form').querySelector('input.has-error');
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    state.guest.firstName = el('field-first-name').value.trim();
    state.guest.lastName = el('field-last-name').value.trim();
    state.guest.email = el('field-email').value.trim();
    state.guest.phone = el('field-phone').value.trim();

    el('btn-continue-to-payment').disabled = true;
    showSpinner('Checking payment options...');
    checkPaymentInfo();
  }

  /* ----------------------------------------------------------
     Payment info check — Step 3
  ---------------------------------------------------------- */
  function checkPaymentInfo() {
    fetch(API_BASE + '/config')
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        state.config = data;
        hideSpinner();
        el('btn-continue-to-payment').disabled = false;
        goToStep(3);
        if (!data.bookingOpen || !data.publishableKey) {
          el('stripe-elements-form').setAttribute('hidden', '');
          el('checkout-payment-fallback').removeAttribute('hidden');
          el('btn-fallback-portal').href = FALLBACK_URL;
          el('checkout-title').textContent = 'Reserve by Email';
        } else {
          el('checkout-payment-fallback').setAttribute('hidden', '');
          initStripeElements(data.publishableKey);
        }
      })
      .catch(function () {
        hideSpinner();
        el('btn-continue-to-payment').disabled = false;
        showError('Unable to load payment options. Please try again.', FALLBACK_URL);
      });
  }

  /* ----------------------------------------------------------
     Event wiring (attached once on DOMContentLoaded)
  ---------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    // Drawer open/close
    el('checkout-close-btn').addEventListener('click', closeDrawer);
    el('checkout-overlay').addEventListener('click', closeDrawer);

    // Escape key closes drawer
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && state.currentStep > 0) {
        closeDrawer();
      }
    });

    // Step navigation
    el('btn-continue-to-step2').addEventListener('click', enterStep2);
    el('btn-back-to-step1').addEventListener('click', function () { goToStep(1); });

    // Guest form submit
    el('checkout-guest-form').addEventListener('submit', handleGuestFormSubmit);

    // Step 3 back + confirm
    el('btn-back-to-step2').addEventListener('click', function () { goToStep(2); });
    el('co-confirm-btn').addEventListener('click', submitPayment);

    // Step 4 done
    el('btn-confirmation-done').addEventListener('click', closeDrawer);

    // Blur-time field validation
    el('field-first-name').addEventListener('blur', function () {
      validateField('field-first-name', 'err-first-name', validateRequired);
    });
    el('field-last-name').addEventListener('blur', function () {
      validateField('field-last-name', 'err-last-name', validateRequired);
    });
    el('field-email').addEventListener('blur', function () {
      validateField('field-email', 'err-email', validateEmail);
    });
    el('field-phone').addEventListener('blur', function () {
      validateField('field-phone', 'err-phone', validatePhone);
    });

    // Wire .book-direct-btn and [data-checkout-open] buttons to open the checkout
    // Depends on window.selectedCheckIn / window.selectedCheckOut set by the existing site date picker.
    // Falls back to an alert if dates not yet selected.
    document.querySelectorAll('.book-direct-btn, [data-checkout-open]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        // BOOKING KILL SWITCH — intercept at button level too
        if (BOOKING_DISABLED) {
          showMaintenanceModal();
          return;
        }
        // Opened from a private booking link: every Book button reopens that guest's stay.
        if (pageOffer) {
          openPageOffer();
          return;
        }
        // The existing site stores dates in window.selectedCheckIn / window.selectedCheckOut
        var checkIn = window.selectedCheckIn || null;
        var checkOut = window.selectedCheckOut || null;
        var guests = window.selectedGuests || 2;
        if (!checkIn || !checkOut) {
          // UX: instead of a blocking browser alert, smooth-scroll
          // the user down to the date picker module and pop the check-in
          // calendar open so they land exactly where they need to act.
          var target = document.getElementById('price-widget');
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Wait for the scroll to settle before opening the calendar so the
            // overlay positions correctly relative to the trigger button.
            setTimeout(function () {
              if (typeof window.openCal === 'function') {
                window.openCal('checkin');
              } else {
                var btn = document.getElementById('pw-checkin-btn');
                if (btn) btn.focus();
              }
            }, 600);
          }
          return;
        }
        window.checkoutOpen({ checkIn: checkIn, checkOut: checkOut, guests: guests });
      });
    });

    // Last, once the drawer is wired: open the checkout if this page was reached by a
    // private booking link.
    loadPageOffer();
  });

})();
