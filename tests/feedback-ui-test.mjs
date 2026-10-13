import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../feedback.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const summary = (count = 0, average = 0) => ({ count, average, distribution: { 1: 0, 2: 0, 3: 0, 4: count, 5: 0 } });
const review = (id = 1, overrides = {}) => ({ id, name: 'Bea', rating: 4, comment: 'Useful lessons.', suggestion: '', createdAt: '2026-10-13T01:00:00Z', ...overrides });
const page = (reviews = [], hasMore = false) => ({ summary: summary(reviews.length, reviews.length ? 4 : 0), reviews, hasMore });

// Only the DOM operations used by the controller are modeled. No HTML rendering
// or browser layout is simulated; an HTML insertion deliberately fails the test.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.style = { setProperty: (name, value) => this.attributes.set(`style:${name}`, value) };
    this.classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const selected = force ?? !this.classes.has(name);
        selected ? this.classes.add(name) : this.classes.delete(name);
        return selected;
      },
    };
    this.disabled = this.hidden = this.checked = false;
    this.value = this.defaultValue = this.text = '';
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Unsafe HTML insertion'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type) {
    return Promise.all((this.listeners.get(type) ?? []).map((listener) => listener({ preventDefault() {}, target: this })));
  }
}

function boot() {
  const elements = new Map();
  const formMarkup = markup.match(/<form\b[^>]*id="feedback-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(formMarkup, 'The real landing page must contain the feedback form');
  for (const match of markup.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match;
    const element = new Element(tag);
    element.disabled = /\bdisabled\b/.test(attributes);
    element.hidden = /\bhidden\b/.test(attributes);
    element.name = attributes.match(/\bname="([^"]*)"/)?.[1];
    element.value = element.defaultValue = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    element.dataset.endpoint = attributes.match(/\bdata-endpoint="([^"]*)"/)?.[1];
    elements.set(id, element);
  }
  const get = (id) => { assert.ok(elements.has(id), `Missing real page element: ${id}`); return elements.get(id); };
  const form = get('feedback-form');
  const controls = [...formMarkup.matchAll(/<(?:input|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) => get(match[1]));
  const ratings = controls.filter((control) => control.name === 'rating');
  ratings.forEach((rating) => { rating.nextElementSibling = new Element('label'); });
  form.querySelectorAll = (selector) => {
    assert.ok(['input[name="rating"]', 'input, textarea'].includes(selector), `Unsupported selector: ${selector}`);
    return selector === 'input[name="rating"]' ? ratings : controls;
  };
  form.querySelector = (selector) => {
    assert.equal(selector, 'input[name="rating"]:checked');
    return ratings.find((rating) => rating.checked) ?? null;
  };
  form.reportValidity = () => ratings.some((rating) => rating.checked);
  form.reset = () => controls.forEach((control) => { control.value = control.defaultValue; control.checked = false; });
  get('feedback-status').textContent = 'Connecting to feedback…';
  const calls = [];
  class BrowserFormData {
    constructor(element) {
      this.fields = new Map(controls.filter((control) => !control.disabled && (control.name !== 'rating' || control.checked)).map((control) => [control.name, control.value]));
      assert.equal(element, form);
    }
    get(name) { return this.fields.get(name) ?? null; }
  }
  const context = vm.createContext({
    document: { baseURI: 'https://example.test/bh_landingpage/', getElementById: get, createElement: (tag) => new Element(tag) },
    FormData: BrowserFormData, URL, AbortController, TypeError,
    window: { setTimeout, clearTimeout },
    fetch: (url, options) => new Promise((resolve, reject) => calls.push({ url: new URL(url), options, resolve, reject })),
  });
  vm.runInContext(source, context, { filename: 'feedback.js' });
  const reply = (index, data, status = 200, contentType = 'application/json') => {
    assert.ok(calls[index], `Expected HTTP request ${index + 1}`);
    calls[index].resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => contentType }, json: async () => data });
  };
  const choose = async (value) => {
    ratings.forEach((rating) => { rating.checked = rating.value === String(value); });
    await ratings.find((rating) => rating.checked).fire('change');
  };
  return { get, form, controls, ratings, calls, reply, choose, context };
}

async function ready(data = page()) {
  const app = boot();
  app.reply(0, data);
  await flush();
  return app;
}

test('initial request gates submission and renders an honest empty state', async () => {
  const app = boot();
  assert.equal(app.calls[0].url.href, 'https://example.test/bh_landingpage/api/feedback.php?limit=6&offset=0');
  assert.equal(app.get('feedback-submit').disabled, true);
  assert.equal(app.get('feedback-list').getAttribute('aria-busy'), 'true');
  app.reply(0, page());
  await flush();
  assert.equal(app.get('feedback-submit').disabled, false);
  assert.equal(app.get('rating-average').textContent, '—');
  assert.match(app.get('rating-count').textContent, /No ratings yet/);
  assert.equal(app.get('rating-summary-stars').getAttribute('aria-label'), 'No ratings yet');
  assert.equal(app.get('feedback-list').children.length, 0);
  assert.equal(app.get('feedback-empty').hidden, false);
  assert.equal(app.get('feedback-load-more').hidden, true);
});

test('changing the rating updates all selected stars and its readable label', async () => {
  const app = await ready();
  await app.choose(4);
  assert.deepEqual(app.ratings.map((rating) => rating.nextElementSibling.classList.contains('is-selected')), [true, true, true, true, false]);
  assert.match(app.get('rating-choice-label').textContent, /^4 stars/);
  await app.choose(2);
  assert.deepEqual(app.ratings.map((rating) => rating.nextElementSibling.classList.contains('is-selected')), [true, true, false, false, false]);
});

test('successful submission sends captured fields, locks editing, and refreshes saved ratings', async () => {
  const app = await ready();
  await app.choose(4);
  app.get('feedback-name').value = ' Bea ';
  app.get('feedback-comment').value = ' Useful lessons. ';
  app.get('feedback-suggestion').value = ' Add quizzes. ';
  const pending = app.form.fire('submit');
  assert.equal(app.calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(app.calls[1].options.body), { rating: 4, name: 'Bea', comment: 'Useful lessons.', suggestion: 'Add quizzes.', website: '' });
  assert.equal(app.calls[1].options.credentials, 'same-origin');
  assert.ok(app.controls.every((control) => control.disabled));
  assert.equal(app.form.getAttribute('aria-busy'), 'true');
  app.reply(1, { summary: summary(1, 4), review: review() }, 201);
  await flush();
  assert.equal(app.calls[2].url.searchParams.get('offset'), '0');
  assert.equal(app.get('feedback-submit').disabled, true);
  app.reply(2, page([review(1, { suggestion: 'Add quizzes.' })]));
  await pending;
  assert.equal(app.get('rating-average').textContent, '4.0');
  assert.match(app.get('rating-count').textContent, /1 rating/);
  assert.equal(app.get('feedback-list').children.length, 1);
  assert.match(app.get('feedback-list').textContent, /Add quizzes\./);
  assert.match(app.get('feedback-status').textContent, /Thank you/);
  assert.equal(app.get('feedback-comment').value, '');
  assert.ok(app.ratings.every((rating) => !rating.checked));
  assert.ok(app.controls.every((control) => !control.disabled));
  assert.equal(app.get('feedback-submit').disabled, false);
});

test('POST network failure keeps the draft and restores usable controls', async () => {
  const app = await ready();
  await app.choose(3);
  app.get('feedback-comment').value = 'Please keep my draft.\nAnother thought.';
  app.get('feedback-suggestion').value = 'More local examples';
  const pending = app.form.fire('submit');
  app.calls[1].reject(new TypeError('Network failed'));
  await pending;
  assert.equal(app.get('feedback-comment').value, 'Please keep my draft.\nAnother thought.');
  assert.equal(app.get('feedback-suggestion').value, 'More local examples');
  assert.equal(app.ratings[2].checked, true);
  assert.equal(app.get('feedback-submit').disabled, false);
  assert.ok(app.controls.every((control) => !control.disabled));
  assert.equal(app.form.getAttribute('aria-busy'), 'false');
  assert.ok(app.get('feedback-status').classList.contains('is-error'));
  assert.match(app.get('feedback-status').textContent, /may have been saved/);
});

test('repeated submit events cannot create a second request while saving', async () => {
  const app = await ready();
  await app.choose(4);
  const pending = app.form.fire('submit');
  await app.form.fire('submit');
  assert.equal(app.calls.length, 2);
  app.reply(1, { summary: summary(1, 4), review: review() }, 201);
  await flush();
  app.reply(2, page([review()]));
  await pending;
  assert.equal(app.calls.filter((call) => call.options.method === 'POST').length, 1);
});

test('loading another page disables submission, appends reviews, then restores controls', async () => {
  const app = await ready({ ...page([review()]), summary: summary(2, 4), hasMore: true });
  await app.choose(4);
  const pending = app.get('feedback-load-more').fire('click');
  assert.equal(app.calls[1].url.searchParams.get('offset'), '1');
  assert.equal(app.get('feedback-submit').disabled, true);
  assert.equal(app.get('feedback-load-more').disabled, true);
  await app.form.fire('submit');
  assert.equal(app.calls.length, 2);
  app.reply(1, { ...page([review(2)]), summary: summary(2, 4) });
  await pending;
  assert.equal(app.get('feedback-list').children.length, 2);
  assert.equal(app.get('feedback-submit').disabled, false);
  assert.equal(app.get('feedback-load-more').hidden, true);
});

test('a failed additional page retains already loaded feedback and offers retry', async () => {
  const app = await ready({ ...page([review()]), hasMore: true });
  const pending = app.get('feedback-load-more').fire('click');
  app.calls[1].reject(new TypeError('Network failed'));
  await pending;
  assert.equal(app.get('feedback-list').children.length, 1);
  assert.equal(app.get('feedback-retry').hidden, false);
  assert.equal(app.get('feedback-submit').disabled, false);
  assert.ok(app.get('feedback-list-status').classList.contains('is-error'));
});

test('recent feedback treats names, comments, and suggestions as literal text', async () => {
  const content = { name: '<img src=x onerror=alert(1)>', comment: '<script>window.pwned=1</script>', suggestion: '<svg onload=alert(2)>Try this</svg>' };
  const app = await ready(page([review(1, content)]));
  const list = app.get('feedback-list');
  assert.equal(list.children.length, 1);
  for (const value of Object.values(content)) assert.ok(list.textContent.includes(value));
  const tags = [];
  const visit = (element) => { tags.push(element.tagName); element.children.forEach(visit); };
  visit(list);
  assert.ok(!tags.some((tag) => ['SCRIPT', 'IMG', 'SVG'].includes(tag)));
  assert.equal(app.context.window.pwned, undefined);
});

test('initial non-JSON failure disables saving until a successful retry', async () => {
  const app = boot();
  app.reply(0, {}, 502, 'text/html');
  await flush();
  assert.equal(app.get('feedback-submit').disabled, true);
  assert.equal(app.get('feedback-retry').hidden, false);
  assert.match(app.get('rating-count').textContent, /temporarily unavailable/);
  const pending = app.get('feedback-retry').fire('click');
  app.reply(1, page());
  await pending;
  assert.equal(app.get('feedback-submit').disabled, false);
  assert.equal(app.get('feedback-retry').hidden, true);
  assert.equal(app.get('feedback-status').textContent, '');
});

test('malformed JSON displays a friendly service failure rather than a parser error', async () => {
  const app = boot();
  app.calls[0].resolve({
    ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
  });
  await flush();
  assert.equal(app.get('feedback-submit').disabled, true);
  assert.equal(app.get('feedback-retry').hidden, false);
  assert.match(app.get('feedback-status').textContent, /temporarily unavailable/);
  assert.doesNotMatch(app.get('feedback-status').textContent, /Unexpected token/);
});
