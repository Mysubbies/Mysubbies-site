const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
for (const file of ['index.html', 'mysubbies-website.html']) {
  test(`${file}: cart quantity changes use current rates and minimum job price`, () => {
    const html = readFileSync(file, 'utf8');
    const source = html.slice(html.indexOf('  function updateCartQuantity('), html.indexOf('  function removeFromCart('));
    const context = { cart: [{catLabel:'Cleaning', taskName:'Clean', qty:1, base:100}], CATEGORIES:[{label:'Cleaning', tasks:[{name:'Clean',rate:25,minJobPrice:100}]}],renderCart(){},estResetPriceReveal(){} };
    vm.createContext(context); vm.runInContext(source, context);
    context.updateCartQuantity(0, 2); assert.equal(context.cart[0].base, 100);
    context.updateCartQuantity(0, 8); assert.equal(context.cart[0].base, 200);
    context.updateCartQuantity(0, -3); assert.equal(context.cart[0].qty, 8);
    context.updateCartQuantity(0, 'bad'); assert.equal(context.cart[0].qty, 8);
    context.updateCartQuantity(0, Infinity); assert.equal(context.cart[0].qty, 8);
    assert.match(html, /onchange="updateCartQuantity/);
  });
}
