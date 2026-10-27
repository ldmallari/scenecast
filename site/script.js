// Code stays readable and selectable without JavaScript or clipboard access.
document.querySelectorAll('pre').forEach((pre, index) => {
  const code = pre.querySelector('code');
  if (!code || pre.closest('.feature-example')) return;
  const block = document.createElement('div');
  block.className = 'code-block';
  pre.before(block);
  block.append(pre);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', `Copy code block ${index + 1}`);
  const status = document.createElement('div');
  status.className = 'copy-status';
  status.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.className = 'code-label';
  label.setAttribute('aria-hidden', 'true');
  label.textContent = code.classList.contains('language-sh') ? 'Terminal' :
    code.classList.contains('language-yaml') ? 'Scene / YAML' : 'Reference';
  block.append(label, button, status);
  let reset;
  button.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
      status.textContent = 'Copied to clipboard.';
      reset = setTimeout(() => {
        button.textContent = 'Copy';
        status.textContent = '';
      }, 2500);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Copy unavailable. Text selected; copy it manually.';
    }
  });
});

// A small, local syntax treatment. Text nodes preserve the exact copyable source.
document.querySelectorAll('pre code').forEach(code => {
  const fragment = document.createDocumentFragment();
  const tokens = /(^\s*#[^\n]*$)|(^\s*(?:-\s+)?[\w.-]+:)/gm;
  const text = code.textContent;
  let from = 0;
  for (const match of text.matchAll(tokens)) {
    fragment.append(document.createTextNode(text.slice(from, match.index)));
    const token = document.createElement('span');
    token.className = match[1] ? 'syntax-comment' : 'syntax-key';
    token.textContent = match[0];
    fragment.append(token);
    from = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(from)));
  code.replaceChildren(fragment);
});

// The demo autoplays muted without JavaScript. With it, reduced motion holds the poster and the toggle plays it.
const demo = document.querySelector('#demo-video');
const toggle = document.querySelector('.demo-toggle');
if (demo && toggle) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motion.matches;
  function updateDemo() {
    if (paused) {
      demo.autoplay = false;
      demo.pause();
    } else {
      demo.play().catch(() => {});
    }
    toggle.textContent = paused ? 'Play demo' : 'Pause demo';
    toggle.setAttribute('aria-pressed', String(paused));
  }
  if (paused) {
    // If autoplay already began before this script ran, reload so the poster shows again.
    demo.removeAttribute('autoplay');
    if (!demo.paused || demo.currentTime > 0) demo.load();
  }
  updateDemo();
  toggle.hidden = false;
  toggle.addEventListener('click', () => { paused = !paused; updateDemo(); });
  motion.addEventListener('change', () => { paused = motion.matches; updateDemo(); });
}

// The TOC remains ordinary anchor navigation when observation is unavailable.
const tocLinks = document.querySelectorAll('.toc a');
if (tocLinks.length && 'IntersectionObserver' in window) {
  const visible = new Map();
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => { visible.set(entry.target.id, entry.isIntersecting); });
    const active = [...tocLinks].find(link => visible.get(link.hash.slice(1)));
    if (!active) return;
    tocLinks.forEach(link => {
      if (link === active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-5% 0px -65% 0px' });
  tocLinks.forEach(link => {
    const heading = document.getElementById(link.hash.slice(1));
    if (heading) observer.observe(heading);
  });
}
