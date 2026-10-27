document.querySelectorAll('pre').forEach((pre, index) => {
  const code = pre.querySelector('code');
  if (!code) return;

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
  block.append(button, status);

  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      status.textContent = 'Copied to clipboard.';
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

document.querySelectorAll('.demo').forEach((demo) => {
  demo.open = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
});
