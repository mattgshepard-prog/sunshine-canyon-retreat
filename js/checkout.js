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
  const API_BASE = 'https://sunshine-canyon-api.vercel.app';
  const FALLBACK_URL = 'https://svpartners.guestybookings.com/en/properties/693366e4e2c2460012d9ed96';

  /* ----------------------------------------------------------
     Internal state
  ---------------------------------------------------------- */
  const state = {
    checkIn: null,           // YYYY-MM-DD
    checkOut: null,          // YYYY-MM-DD
    guests: 2,               // integer
    quote: null,             // full /api/quote response
    selectedRatePlan: null,  // ratePlans[0] by default
    guest: {                 // from form fields
      firstName: '',
      lastName: '',
      email: '',
      phone: ''
    },
    selectedUpsells: [],     // array of upsell id strings
    upsellItems: [],         // catalog from /api/upsells
    paymentInfo: null,       // /api/payment-info response
    currentStep: 0,          // 0=closed, 1=step1, 2=step2, 3=step3, 4=step4
    stripeInstance: null,    // Stripe() instance (created in initStripeElements)
    cardElement: null        // Stripe CardElement (mounted to #card-element)
  };

  /* ----------------------------------------------------------
     DOM helper
  ---------------------------------------------------------- */
  function el(id) { return document.getElementById(id); }

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
    el('checkout-drawer').classList.add('is-open');
    el('checkout-overlay').classList.add('is-visible');
    document.body.style.overflow = 'hidden';
    el('checkout-drawer').setAttribute('aria-hidden', 'false');
  }

  function resetDrawer() {
    state.currentStep = 0;
    state.quote = null;
    state.guest = { firstName: '', lastName: '', email: '', phone: '' };
    state.selectedUpsells = [];
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
    // After transition completes, reset state
    setTimeout(function () { resetDrawer(); }, 350);
  }

  /* ----------------------------------------------------------
     Step navigation
  ---------------------------------------------------------- */
  var STEP_TITLES = {
    1: 'Review Your Stay',
    2: 'Your Details & Add-Ons',
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

  function renderStep1() {
    if (!state.selectedRatePlan) {
      showError('Unable to load quote details.', FALLBACK_URL);
      return;
    }
    var rp = state.selectedRatePlan;
    var totals = rp.totals;

    // Build nights breakdown
    var dtf = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC'
    });
    var nightsHtml = '';
    var days = rp.days || [];
    days.forEach(function (d) {
      var dateStr = dtf.format(new Date(d.date));
      nightsHtml += '<div class="quote-night-row"><span>' + dateStr + '</span><span>' + formatMoney(d.price) + '</span></div>';
    });
    el('quote-nights-breakdown').innerHTML = nightsHtml;

    // Build line items
    var nightCount = days.length;
    var lineHtml = '';
    lineHtml += '<div class="quote-line"><span>Accommodation (' + nightCount + ' night' + (nightCount !== 1 ? 's' : '') + ')</span><span>' + formatMoney(totals.accommodation) + '</span></div>';
    lineHtml += '<div class="quote-line"><span>Cleaning fee</span><span>' + formatMoney(totals.cleaning) + '</span></div>';
    if (totals.fees > 0) {
      lineHtml += '<div class="quote-line"><span>Fees</span><span>' + formatMoney(totals.fees) + '</span></div>';
    }
    lineHtml += '<div class="quote-line"><span>Taxes</span><span>' + formatMoney(totals.taxes) + '</span></div>';
    lineHtml += '<div class="quote-line is-total"><span>Total</span><span>' + formatMoney(totals.total) + '</span></div>';
    el('quote-line-items').innerHTML = lineHtml;

    // Deposit notice
    var remaining = totals.total - 50;
    el('quote-remaining-balance').textContent = formatMoney(remaining);
  }

  function fetchQuote() {
    var body = JSON.stringify({
      checkIn: state.checkIn,
      checkOut: state.checkOut,
      guests: state.guests,
      guest: { firstName: 'Guest', lastName: 'Guest', email: 'guest@example.com', phone: '+10000000000' }
    });

    fetch(API_BASE + '/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    })
      .then(function (resp) {
        if (!resp.ok) {
          return resp.json().catch(function () { return {}; }).then(function (data) {
            var fallback = data.fallbackUrl || FALLBACK_URL;
            var msg;
            if (resp.status === 400) {
              msg = 'These dates are not available. Please select different dates.';
            } else {
              msg = 'Unable to load pricing. Please try again.';
            }
            hideSpinner();
            showError(msg, fallback);
          });
        }
        return resp.json().then(function (data) {
          state.quote = data;
          state.selectedRatePlan = (data.ratePlans && data.ratePlans[0]) || null;
          hideSpinner();
          renderStep1();
          el('btn-continue-to-step2').disabled = false;
        });
      })
      .catch(function () {
        hideSpinner();
        showError('Connection error. Please check your internet and try again.', FALLBACK_URL);
      });
  }

  /* ----------------------------------------------------------
     Public API
  ---------------------------------------------------------- */
  window.checkoutOpen = async function ({ checkIn, checkOut, guests = 2 }) {
    // Validate params
    if (!checkIn || typeof checkIn !== 'string' || !checkOut || typeof checkOut !== 'string') {
      console.error('checkoutOpen: checkIn and checkOut must be non-empty strings');
      return;
    }
    state.checkIn = checkIn;
    state.checkOut = checkOut;
    state.guests = guests;

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
    if (state.upsellItems.length === 0) {
      fetchUpsells();
    } else {
      renderUpsells();
    }
  }

  function fetchUpsells() {
    showSpinner('Loading add-ons...');
    fetch(API_BASE + '/api/upsells')
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        state.upsellItems = data.items || [];
        hideSpinner();
        renderUpsells();
      })
      .catch(function () {
        hideSpinner();
        // Upsell failure is non-blocking
        state.upsellItems = [];
        renderUpsells();
      });
  }

  function renderUpsells() {
    var upsellSection = el('checkout-upsells');
    if (state.upsellItems.length === 0) {
      if (upsellSection) upsellSection.style.display = 'none';
      return;
    }
    if (upsellSection) upsellSection.style.display = '';

    var html = '';
    state.upsellItems.forEach(function (item) {
      var isChecked = state.selectedUpsells.indexOf(item.id) !== -1;
      var isSelected = isChecked ? ' is-selected' : '';
      html += '<div class="upsell-item' + isSelected + '" data-upsell-id="' + escapeHtml(item.id) + '">';
      html += '<input type="checkbox" id="upsell-' + escapeHtml(item.id) + '" aria-label="' + escapeHtml(item.name) + '"' + (isChecked ? ' checked' : '') + '>';
      html += '<div>';
      html += '<div class="upsell-item-name">' + escapeHtml(item.name) + '</div>';
      html += '<div class="upsell-item-desc">' + escapeHtml(item.description) + '</div>';
      html += '</div>';
      html += '<div class="upsell-item-price">+' + formatMoney(item.price) + '</div>';
      html += '</div>';
    });
    el('upsell-list').innerHTML = html;

    // Attach change listeners
    state.upsellItems.forEach(function (item) {
      var checkbox = document.getElementById('upsell-' + item.id);
      if (checkbox) {
        checkbox.addEventListener('change', function () {
          toggleUpsell(item.id, this.checked);
        });
      }
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toggleUpsell(id, checked) {
    var idx = state.selectedUpsells.indexOf(id);
    if (checked && idx === -1) {
      state.selectedUpsells.push(id);
    } else if (!checked && idx !== -1) {
      state.selectedUpsells.splice(idx, 1);
    }
    // Toggle is-selected class on parent .upsell-item div
    var itemDiv = document.querySelector('.upsell-item[data-upsell-id="' + id + '"]');
    if (itemDiv) {
      if (checked) {
        itemDiv.classList.add('is-selected');
      } else {
        itemDiv.classList.remove('is-selected');
      }
    }
    updateUpsellTotal();
  }

  function updateUpsellTotal() {
    var total = 0;
    state.upsellItems.forEach(function (item) {
      if (state.selectedUpsells.indexOf(item.id) !== -1) {
        total += item.price;
      }
    });
    var totalRow = el('upsell-total-row');
    if (total > 0) {
      totalRow.removeAttribute('hidden');
      el('upsell-total-amount').textContent = formatMoney(total);
    } else {
      totalRow.setAttribute('hidden', '');
    }
  }

  /* ----------------------------------------------------------
     Step 3 — Stripe Elements initialization
  ---------------------------------------------------------- */
  function initStripeElements(publishableKey, accountId) {
    // Show elements form, hide fallback
    el('stripe-elements-form').removeAttribute('hidden');
    el('checkout-payment-fallback').setAttribute('hidden', '');

    // Populate charge notice
    var remaining = state.selectedRatePlan ? (state.selectedRatePlan.totals.total - 50) : 0;
    el('co-charge-notice').textContent = 'You will be charged $50 today. Remaining ' + formatMoney(remaining) + ' will be charged 14 days before check-in.';

    // Initialize Stripe with connected account
    state.stripeInstance = Stripe(publishableKey, { stripeAccount: accountId });
    var elements = state.stripeInstance.elements();

    var cardStyle = {
      base: {
        color: '#f0ead6',
        fontSize: '16px',
        fontFamily: 'inherit',
        '::placeholder': { color: '#a8a090' },
        iconColor: '#c9a96e'
      },
      invalid: {
        color: '#e07070',
        iconColor: '#e07070'
      }
    };

    state.cardElement = elements.create('card', { style: cardStyle, hidePostalCode: true });
    state.cardElement.mount('#card-element');

    // Show card errors inline
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

    // Policy checkbox controls confirm button
    var policyCheckbox = el('co-policy-checkbox');
    var confirmBtn = el('co-confirm-btn');
    confirmBtn.disabled = true;
    policyCheckbox.checked = false;
    policyCheckbox.addEventListener('change', function () {
      confirmBtn.disabled = !policyCheckbox.checked;
    });
  }

  /* ----------------------------------------------------------
     Step 3 — Submit payment (create PaymentMethod → call /api/book)
  ---------------------------------------------------------- */
  function submitPayment() {
    if (!state.stripeInstance || !state.cardElement) {
      showError('Payment form not ready. Please try again.', FALLBACK_URL);
      return;
    }

    showSpinner('Processing payment...');
    hideError();

    state.stripeInstance.createPaymentMethod({
      type: 'card',
      card: state.cardElement,
      billing_details: {
        name: state.guest.firstName + ' ' + state.guest.lastName,
        email: state.guest.email,
        phone: state.guest.phone
      }
    }).then(function (result) {
      if (result.error) {
        hideSpinner();
        var errorDiv = el('card-errors');
        errorDiv.textContent = result.error.message;
        errorDiv.removeAttribute('hidden');
        // Re-enable confirm button if policy still checked
        var policyCheckbox = el('co-policy-checkbox');
        el('co-confirm-btn').disabled = !policyCheckbox.checked;
        return;
      }

      var pmToken = result.paymentMethod.id;

      var bookBody = JSON.stringify({
        quoteId: state.quote.quoteId,
        ratePlanId: state.selectedRatePlan.ratePlanId,
        ccToken: pmToken,
        guest: state.guest,
        upsells: state.selectedUpsells,
        checkIn: state.checkIn,
        checkOut: state.checkOut
      });

      fetch(API_BASE + '/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bookBody
      })
        .then(function (resp) {
          return resp.json().then(function (data) {
            return { ok: resp.ok, status: resp.status, data: data };
          });
        })
        .then(function (res) {
          hideSpinner();
          if (!res.ok) {
            var msg = (res.data && res.data.error)
              ? res.data.error
              : 'Booking failed. Please try again or use the partner portal.';
            showError(msg, (res.data && res.data.fallbackUrl) || FALLBACK_URL);
            // Reset card element — token is single-use
            if (state.cardElement) state.cardElement.clear();
            el('co-confirm-btn').disabled = true;
            el('co-policy-checkbox').checked = false;
            return;
          }
          renderStep4(res.data);
          goToStep(4);
        })
        .catch(function () {
          hideSpinner();
          showError('Connection error during booking. Please try again.', FALLBACK_URL);
          if (state.cardElement) state.cardElement.clear();
          el('co-confirm-btn').disabled = true;
          el('co-policy-checkbox').checked = false;
        });
    });
  }

  /* ----------------------------------------------------------
     Step 4 — Render confirmation screen
  ---------------------------------------------------------- */
  function renderStep4(bookingData) {
    el('co-confirmation-code').textContent = bookingData.confirmationCode || '—';

    el('co-confirmation-email-notice').textContent =
      'A confirmation email has been sent to ' + escapeHtml(state.guest.email) + '.';

    // Details block: property, guest, dates
    var dtf = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    var detailsHtml = '';
    detailsHtml += '<div><strong>Property:</strong> Sunshine Canyon Retreat</div>';
    detailsHtml += '<div><strong>Guest:</strong> ' + escapeHtml(state.guest.firstName) + ' ' + escapeHtml(state.guest.lastName) + '</div>';
    detailsHtml += '<div><strong>Check-in:</strong> ' + dtf.format(new Date(state.checkIn)) + '</div>';
    detailsHtml += '<div><strong>Check-out:</strong> ' + dtf.format(new Date(state.checkOut)) + '</div>';
    el('co-confirmation-details').innerHTML = detailsHtml;

    // Upsells block
    var selectedUpsellItems = state.upsellItems.filter(function (item) {
      return state.selectedUpsells.indexOf(item.id) !== -1;
    });
    if (selectedUpsellItems.length > 0) {
      var upsellHtml = '<div style="font-weight:600;margin-bottom:8px;color:var(--co-text)">Add-Ons Selected</div>';
      selectedUpsellItems.forEach(function (item) {
        upsellHtml += '<div class="co-confirmation-upsell-row"><span>' + escapeHtml(item.name) + '</span><span>' + formatMoney(item.price) + '</span></div>';
      });
      el('co-confirmation-upsells').innerHTML = upsellHtml;
      el('co-confirmation-upsells').removeAttribute('hidden');
    } else {
      el('co-confirmation-upsells').setAttribute('hidden', '');
    }

    // Total
    if (state.selectedRatePlan && state.selectedRatePlan.totals) {
      var upsellTotal = selectedUpsellItems.reduce(function (sum, item) { return sum + item.price; }, 0);
      var grandTotal = state.selectedRatePlan.totals.total + upsellTotal;
      el('co-confirmation-total').textContent = 'Total: ' + formatMoney(grandTotal);
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
      el(errorId).textContent = errorMsg;
      el(errorId).removeAttribute('hidden');
      return false;
    }
    input.classList.remove('has-error');
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
    fetch(API_BASE + '/api/payment-info')
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        state.paymentInfo = data;
        hideSpinner();
        goToStep(3);
        if (data.stripePublishableKey === null) {
          el('checkout-payment-fallback').removeAttribute('hidden');
          el('btn-fallback-portal').href = data.fallbackUrl || FALLBACK_URL;
          el('checkout-step-indicator').textContent = 'Fallback Mode';
          el('checkout-title').textContent = 'Complete Your Booking';
        } else {
          el('checkout-payment-fallback').setAttribute('hidden', '');
          initStripeElements(data.stripePublishableKey, data.stripeAccountId);
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
        // The existing site stores dates in window.selectedCheckIn / window.selectedCheckOut
        var checkIn = window.selectedCheckIn || null;
        var checkOut = window.selectedCheckOut || null;
        var guests = window.selectedGuests || 2;
        if (!checkIn || !checkOut) {
          alert('Please select your check-in and check-out dates first.');
          return;
        }
        window.checkoutOpen({ checkIn: checkIn, checkOut: checkOut, guests: guests });
      });
    });
  });

})();
