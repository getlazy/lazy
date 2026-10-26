/** Refused actions remain real controls, with their server-provided answer on click. */
export function controlRefusalScript(): string {
  return `<script>
(function () {
  function explain(event) {
    var target = event.type === 'submit' ? (event.submitter || event.target.querySelector('[type=submit][aria-busy="true"]')) : event.target;
    var control = target && target.closest ? target.closest('[data-control-refusal], [aria-busy="true"]') : null;
    if (!control) return;
    var reason = control.getAttribute('data-control-refusal');
    if (!reason && control.getAttribute('aria-busy') !== 'true') return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var message = control.parentElement.querySelector(':scope > [data-control-refusal-message]');
    if (!message) {
      message = document.createElement('p');
      message.setAttribute('data-control-refusal-message', '');
      message.setAttribute('role', 'alert');
      message.className = 'rv-hint';
      control.parentElement.appendChild(message);
    }
    message.textContent = reason || 'This request is still in progress. Wait for it to finish before trying again.';
  }
  document.addEventListener('click', explain, true);
  document.addEventListener('keydown', explain, true);
  document.addEventListener('submit', explain, true);
})();
</script>`;
}
