'use strict';

(function expose(root, factory) {
  const consent = factory();
  if (typeof module === 'object' && module.exports) module.exports = consent;
  else root.FdeConsent = consent;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const checkbox = (form, name) => form.querySelector(`input[name="${name}"]`);

  function clear(form) {
    checkbox(form, 'processingPermission').checked = false;
    checkbox(form, 'usagePermission').checked = false;
  }

  function consume(form) {
    const permissions = {
      processingPermission: checkbox(form, 'processingPermission').checked,
      usagePermission: checkbox(form, 'usagePermission').checked
    };
    clear(form);
    return permissions;
  }

  return { clear, consume };
});
