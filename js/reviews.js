/* Sunshine Canyon Retreat: the Reviews page.
 *
 * Two jobs:
 *   1. Show the published reviews (GET /reviews). Each one says where the guest posted it.
 *   2. For a guest who opened the private link in their thank-you email (/reviews/?r=CODE),
 *      show the form and send their review (POST /review-invite, POST /review).
 *
 * A review is put on the page with textContent only, never as HTML: these are other people's
 * words, and nothing a guest typed may run as markup.
 *
 * The link's code is taken out of the address bar by the inline script at the top of the page
 * (before analytics) and travels to the API in a request body, never in a URL.
 */
(function () {
  'use strict';

  var API_BASE = 'https://str-manager-api-production.up.railway.app/direct/sunshine';
  var CONTACT_EMAIL = 'amspropertymgt@gmail.com';
  var MIN_BODY = 20;
  var MAX_BODY = 3000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  // The same rule the server applies: letters, with spaces, a period, a hyphen or an apostrophe.
  var NAME_OK = /^\p{L}(?:\p{L}|[ .'\-])*$/u;
  var SOURCES = {
    airbnb: 'Reviewed on Airbnb',
    vrbo: 'Reviewed on Vrbo',
    booking_com: 'Reviewed on Booking.com',
    direct: 'Booked direct'
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function monthYear(value) {
    var m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    var month = MONTHS[parseInt(m[2], 10) - 1];
    return month ? month + ' ' + m[1] : '';
  }

  // ── showing reviews ────────────────────────────────────────────────────────────────────

  function ratingNode(review) {
    var max = Number(review.ratingMax) === 10 ? 10 : 5;
    var rating = Number(review.rating);
    var wrap = el('span');
    if (max === 5 && rating === Math.floor(rating)) {
      // Stars only for a whole rating. A 4.5 drawn as five gold stars would overstate it.
      var whole = Math.max(0, Math.min(5, rating));
      var stars = el('span', 'review-stars', '★'.repeat(whole) + '☆'.repeat(5 - whole));
      stars.setAttribute('aria-hidden', 'true');
      wrap.appendChild(stars);
      wrap.appendChild(el('span', 'sr-only', rating + ' out of 5 stars'));
    } else {
      wrap.appendChild(el('span', 'review-score', rating + ' out of ' + max));
    }
    return wrap;
  }

  function reviewNode(review) {
    var card = el('article', 'review');
    var head = el('div', 'review-head');
    head.appendChild(el('span', 'review-name', review.name || 'Guest'));
    head.appendChild(ratingNode(review));
    card.appendChild(head);

    var meta = el('div', 'review-head');
    meta.appendChild(el('span', 'review-source', SOURCES[review.source] || 'Guest review'));
    var stayed = monthYear(review.stayed);
    if (stayed) meta.appendChild(el('span', 'review-meta', 'Stayed ' + stayed));
    card.appendChild(meta);

    if (review.title) card.appendChild(el('p', 'review-title', review.title));
    card.appendChild(el('p', 'review-body', review.body || ''));

    if (review.hostResponse) {
      var response = el('div', 'review-response');
      response.appendChild(el('div', 'review-response-label', 'Response from the host'));
      response.appendChild(el('p', null, review.hostResponse));
      card.appendChild(response);
    }
    return card;
  }

  // A request that never answers must not leave the page saying "Loading" forever.
  var TIMEOUT_MS = 15000;

  function timedFetch(url, options) {
    if (typeof AbortController === 'undefined') return fetch(url, options);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).then(
      function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function loadReviews() {
    var status = $('reviewsStatus');
    var list = $('reviewsList');
    timedFetch(API_BASE + '/reviews', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var reviews = (data && data.reviews) || [];
        list.textContent = '';
        if (!reviews.length) {
          status.textContent = 'No reviews to show yet.';
          return;
        }
        reviews.forEach(function (review) { list.appendChild(reviewNode(review)); });
        status.textContent = reviews.length === 1 ? '1 review' : reviews.length + ' reviews';
        status.className = 'fine';
      })
      .catch(function () {
        status.textContent = 'The reviews could not be loaded right now. Please try again in a few minutes.';
      });
  }

  // ── a guest's private link ─────────────────────────────────────────────────────────────

  function reviewCode() {
    if (window.__scrReview) return window.__scrReview;
    try {
      var stored = sessionStorage.getItem('scrReview');
      if (stored) return stored;
    } catch (e) { /* storage blocked */ }
    try { return new URL(window.location.href).searchParams.get('r') || ''; } catch (e) { return ''; }
  }

  function forgetCode() {
    window.__scrReview = '';
    try { sessionStorage.removeItem('scrReview'); } catch (e) { /* storage blocked */ }
  }

  function post(path, payload) {
    return timedFetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { ok: r.ok, status: r.status, data: data };
      });
    });
  }

  function showNotice(lines, focus) {
    var box = $('reviewNotice');
    // Shown first, filled second: a live region filled while hidden is not announced.
    box.hidden = false;
    box.textContent = '';
    lines.forEach(function (line) { box.appendChild(el('p', null, line)); });
    if (focus) box.focus();
  }

  function contactLine() {
    return 'Questions? Email us at ' + CONTACT_EMAIL + '.';
  }

  function setError(id, input, message) {
    var node = $(id);
    node.textContent = message || '';
    node.hidden = !message;
    if (input) {
      // aria-describedby rather than aria-errormessage: screen readers support it far better.
      var described = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (x) {
        return x && x !== id;
      });
      if (message) {
        input.setAttribute('aria-invalid', 'true');
        described.push(id);
      } else {
        input.removeAttribute('aria-invalid');
      }
      if (described.length) input.setAttribute('aria-describedby', described.join(' '));
      else input.removeAttribute('aria-describedby');
    }
  }

  function openForm(code, invite) {
    var section = $('reviewFormSection');
    var form = $('reviewForm');
    var body = $('reviewBody');
    var name = $('reviewName');
    var count = $('reviewBodyCount');
    var submit = $('reviewSubmit');
    var status = $('reviewStatus');

    var stayed = monthYear(invite.stayed);
    if (invite.firstName) {
      $('reviewFormHeading').textContent = 'Leave your review, ' + invite.firstName;
      name.value = invite.firstName;
    }
    if (stayed) {
      $('reviewFormIntro').textContent = 'Thank you for staying with us in ' + stayed + '. Tell future guests how it went.';
    }
    section.hidden = false;
    $('reviewFormHeading').focus();

    body.addEventListener('input', function () {
      count.textContent = body.value.length + ' of ' + MAX_BODY;
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var rating = form.querySelector('input[name="rating"]:checked');
      var text = body.value.trim();
      var consent = $('reviewConsent');
      var firstBad = null;

      setError('ratingError', null, rating ? '' : 'Please choose a rating.');
      if (rating) $('ratingField').removeAttribute('aria-invalid');
      else $('ratingField').setAttribute('aria-invalid', 'true');
      if (!rating) firstBad = firstBad || form.querySelector('input[name="rating"]');

      var bodyMessage = '';
      if (text.length < MIN_BODY) bodyMessage = 'Please write at least ' + MIN_BODY + ' characters about your stay.';
      else if (text.length > MAX_BODY) bodyMessage = 'Please keep your review under ' + MAX_BODY + ' characters.';
      setError('bodyError', body, bodyMessage);
      if (bodyMessage) firstBad = firstBad || body;

      var shownName = name.value.replace(/\s+/g, ' ').trim();
      var nameMessage = '';
      if (!shownName) nameMessage = 'Please enter the name to show with your review.';
      else if (!NAME_OK.test(shownName)) nameMessage = 'Please use letters only for the name, for example your first name.';
      setError('nameError', name, nameMessage);
      if (nameMessage) firstBad = firstBad || name;

      setError('consentError', consent, consent.checked ? '' : 'Please tick the box so we can show your review.');
      if (!consent.checked) firstBad = firstBad || consent;

      if (firstBad) {
        status.textContent = 'Please fix the items marked above.';
        firstBad.focus();
        return;
      }

      submit.disabled = true;
      status.textContent = 'Sending your review…';
      post('/review', {
        code: code,
        rating: parseInt(rating.value, 10),
        title: $('reviewTitle').value,
        body: text,
        name: shownName,
        consent: true
      }).then(function (res) {
        if (res.ok) {
          forgetCode();
          section.hidden = true;
          showNotice([
            'Thank you. Your review has been sent to our team.',
            'Reviews are checked before they appear on this page, and they are never edited.'
          ], true);
          return;
        }
        submit.disabled = false;
        var codeName = res.data && res.data.code;
        var message = (res.data && res.data.error) || 'Your review could not be sent. Please try again.';
        if (codeName === 'INVITE_USED' || codeName === 'INVITE_EXPIRED' || codeName === 'INVITE_INVALID') {
          forgetCode();
          section.hidden = true;
          showNotice([message, contactLine()], true);
          return;
        }
        if (codeName === 'RATING_REQUIRED') setError('ratingError', null, message);
        else if (codeName === 'NAME_REQUIRED') setError('nameError', name, message);
        else if (codeName === 'REVIEW_TOO_SHORT' || codeName === 'REVIEW_TOO_LONG') setError('bodyError', body, message);
        else if (codeName === 'CONSENT_REQUIRED') setError('consentError', consent, message);
        status.textContent = message;
      }).catch(function () {
        submit.disabled = false;
        status.textContent = 'Your review could not be sent. Please check your connection and try again. Nothing you wrote has been lost.';
      });
    });
  }

  function loadInvite() {
    var code = reviewCode();
    if (!code) return;
    post('/review-invite', { code: code }).then(function (res) {
      if (res.ok && res.data && res.data.valid) {
        openForm(code, res.data);
        return;
      }
      var codeName = res.data && res.data.code;
      if (codeName === 'INVITE_INVALID' || codeName === 'INVITE_USED' || codeName === 'INVITE_EXPIRED') {
        // The link itself is finished. Only then is the code dropped.
        forgetCode();
        showNotice([res.data.error || 'This review link could not be opened.', contactLine()], false);
        return;
      }
      // Anything else is our side having a bad moment. Keep the code so a reload works.
      showNotice([
        'Your review link could not be checked right now. Please reload the page in a few minutes.',
        contactLine()
      ], false);
    }).catch(function () {
      showNotice([
        'Your review link could not be checked right now. Please reload the page in a few minutes.',
        contactLine()
      ], false);
    });
  }

  loadReviews();
  loadInvite();
})();
