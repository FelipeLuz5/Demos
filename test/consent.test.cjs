'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clear, consume } = require('../public/consent');

function form(processingPermission, usagePermission) {
  const inputs = {
    processingPermission: { checked: processingPermission },
    usagePermission: { checked: usagePermission }
  };
  return {
    inputs,
    querySelector(selector) {
      return inputs[selector.match(/name="([^"]+)"/)[1]];
    }
  };
}

test('consent is consumed only once across consecutive manual submissions', () => {
  const manualForm = form(true, true);

  assert.deepEqual(consume(manualForm), { processingPermission: true, usagePermission: true });
  assert.deepEqual(consume(manualForm), { processingPermission: false, usagePermission: false });

  manualForm.inputs.processingPermission.checked = true;
  manualForm.inputs.usagePermission.checked = true;
  clear(manualForm);
  assert.equal(manualForm.inputs.processingPermission.checked, false);
  assert.equal(manualForm.inputs.usagePermission.checked, false);
});
