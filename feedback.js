(() => {
  'use strict';

  const form = document.getElementById('feedback-form');
  if (!form) return;

  const submitButton = document.getElementById('feedback-submit');
  const status = document.getElementById('feedback-status');
  const listStatus = document.getElementById('feedback-list-status');
  const list = document.getElementById('feedback-list');
  const empty = document.getElementById('feedback-empty');
  const moreButton = document.getElementById('feedback-load-more');
  const retryButton = document.getElementById('feedback-retry');
  const choiceLabel = document.getElementById('rating-choice-label');
  const ratingInputs = [...form.querySelectorAll('input[name="rating"]')];
  const endpoint = new URL(form.dataset.endpoint, document.baseURI);
  const ratingLabels = ['Choose 1 to 5 stars', '1 star — Needs improvement', '2 stars — Could be better', '3 stars — Good', '4 stars — Great', '5 stars — Loved it!'];
  let offset = 0;
  let loading = false;
  let submitting = false;
  let available = false;

  const setStatus = (element, message, error = false) => {
    element.textContent = message;
    element.classList.toggle('is-error', error);
  };

  const updateRatingChoice = () => {
    const selected = Number(form.querySelector('input[name="rating"]:checked')?.value || 0);
    ratingInputs.forEach((input) => {
      input.nextElementSibling.classList.toggle('is-selected', Number(input.value) <= selected);
    });
    choiceLabel.textContent = ratingLabels[selected];
  };
  ratingInputs.forEach((input) => input.addEventListener('change', updateRatingChoice));

  const request = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: { Accept: 'application/json', ...options.headers },
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Feedback is temporarily unavailable. Please try again later.');
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('Feedback is temporarily unavailable. Please try again later.');
      }
      if (!response.ok) {
        const message = response.status === 429
          ? 'You have sent several ratings recently. Please wait 10 minutes before trying again.'
          : (typeof data.error === 'string' ? data.error : 'Feedback could not be saved. Please try again.');
        throw new Error(message);
      }
      return data;
    } catch (error) {
      if ((error.name === 'AbortError' || error instanceof TypeError) && options.method === 'POST') {
        throw new Error('We could not confirm the submission. Your feedback may have been saved. Check the latest feedback before trying again.');
      }
      if (error.name === 'AbortError' || error instanceof TypeError) {
        throw new Error('Could not connect to feedback. Please check your connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const renderSummary = (summary) => {
    const count = Number(summary.count);
    const average = Number(summary.average);
    document.getElementById('rating-average').textContent = count ? average.toFixed(1) : '—';
    document.getElementById('rating-count').textContent = count
      ? `Based on ${count.toLocaleString()} ${count === 1 ? 'rating' : 'ratings'}`
      : 'No ratings yet. Be the first!';
    const stars = document.getElementById('rating-summary-stars');
    stars.style.setProperty('--rating-fill', `${count ? Math.min(100, Math.max(0, average * 20)) : 0}%`);
    stars.setAttribute('aria-label', count ? `${average.toFixed(1)} out of 5 stars` : 'No ratings yet');
    for (let rating = 1; rating <= 5; rating++) {
      const total = Number(summary.distribution[rating] || 0);
      const bar = document.getElementById(`rating-bar-${rating}`);
      bar.max = Math.max(count, 1);
      bar.value = total;
      bar.setAttribute('aria-label', `${total} ${rating} star ${total === 1 ? 'rating' : 'ratings'}`);
      document.getElementById(`rating-total-${rating}`).textContent = total.toLocaleString();
    }
  };

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const renderReview = (review) => {
    const card = createElement('article', 'feedback-card');
    const heading = createElement('div', 'feedback-card-heading');
    const identity = createElement('div', 'feedback-card-identity');
    const avatar = createElement('span', 'feedback-avatar', Array.from(review.name.trim() || 'A')[0].toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const details = createElement('div', 'feedback-card-details');
    details.append(createElement('h4', '', review.name.trim() || 'Anonymous visitor'));
    const date = new Date(review.createdAt);
    if (!Number.isNaN(date.getTime())) {
      const time = createElement('time', '', new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date));
      time.dateTime = review.createdAt;
      details.append(time);
    }
    identity.append(avatar, details);
    const stars = createElement('span', 'feedback-card-stars', '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating));
    stars.setAttribute('role', 'img');
    stars.setAttribute('aria-label', `${review.rating} out of 5 stars`);
    heading.append(identity, stars);
    card.append(heading);
    if (review.comment) card.append(createElement('p', 'feedback-comment', review.comment));
    if (review.suggestion) {
      const suggestion = createElement('div', 'feedback-suggestion');
      suggestion.append(createElement('span', 'feedback-suggestion-label', 'Suggestion'), createElement('p', '', review.suggestion));
      card.append(suggestion);
    }
    if (!review.comment && !review.suggestion) card.append(createElement('p', 'feedback-rating-only', 'Shared an app rating.'));
    return card;
  };

  const loadReviews = async (reset = false) => {
    if (loading) return;
    loading = true;
    submitButton.disabled = true;
    list.setAttribute('aria-busy', 'true');
    moreButton.disabled = true;
    retryButton.disabled = true;
    if (!reset) setStatus(listStatus, 'Loading more feedback…');
    const url = new URL(endpoint);
    url.searchParams.set('limit', '6');
    url.searchParams.set('offset', reset ? '0' : String(offset));
    try {
      const data = await request(url);
      if (!data.summary || !Array.isArray(data.reviews)) throw new Error('Feedback is temporarily unavailable. Please try again later.');
      renderSummary(data.summary);
      if (reset) {
        list.replaceChildren();
        offset = 0;
      }
      const previousIds = new Set([...list.children].map((card) => card.dataset.reviewId));
      data.reviews.forEach((review) => {
        if (previousIds.has(String(review.id))) return;
        const card = renderReview(review);
        card.dataset.reviewId = String(review.id);
        list.append(card);
      });
      offset += data.reviews.length;
      empty.hidden = list.children.length > 0;
      empty.textContent = 'No feedback yet. Your thoughts could be the first!';
      moreButton.hidden = !data.hasMore;
      retryButton.hidden = true;
      available = true;
      submitButton.disabled = submitting;
      if (status.textContent === 'Connecting to feedback…' || status.classList.contains('is-error')) setStatus(status, '');
      setStatus(listStatus, reset ? '' : 'More feedback loaded.');
      return true;
    } catch (error) {
      if (!available) {
        document.getElementById('rating-count').textContent = 'Ratings are temporarily unavailable.';
        empty.textContent = 'We could not load community feedback. Please try again.';
        submitButton.disabled = true;
        setStatus(status, error.message, true);
      }
      setStatus(listStatus, error.message, true);
      retryButton.hidden = false;
      return false;
    } finally {
      loading = false;
      list.setAttribute('aria-busy', 'false');
      moreButton.disabled = false;
      retryButton.disabled = false;
      submitButton.disabled = submitting || !available;
    }
  };

  moreButton.addEventListener('click', () => loadReviews(false));
  retryButton.addEventListener('click', () => loadReviews(true));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || loading || !available || !form.reportValidity()) return;
    submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Sending feedback…';
    form.setAttribute('aria-busy', 'true');
    setStatus(status, 'Sending your feedback…');
    const fields = new FormData(form);
    const editableFields = [...form.querySelectorAll('input, textarea')];
    editableFields.forEach((field) => { field.disabled = true; });
    try {
      const result = await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: Number(fields.get('rating')),
          name: fields.get('name').trim(),
          comment: fields.get('comment').trim(),
          suggestion: fields.get('suggestion').trim(),
          website: fields.get('website'),
        }),
      });
      renderSummary(result.summary);
      form.reset();
      updateRatingChoice();
      setStatus(status, 'Thank you! Your rating and feedback have been shared.');
      await loadReviews(true);
    } catch (error) {
      setStatus(status, error.message, true);
    } finally {
      submitting = false;
      editableFields.forEach((field) => { field.disabled = false; });
      submitButton.disabled = !available;
      submitButton.textContent = 'Submit feedback →';
      form.setAttribute('aria-busy', 'false');
    }
  });

  loadReviews(true);
})();
