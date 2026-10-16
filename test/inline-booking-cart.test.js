const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
 const nodes = { bookingCart: {}, fName:{value:'Sammy'}, fPhone:{value:'0400000000'}, fAddress:{value:'Saved address'}, confirmFreeBooking:{} };
 const context = { quote:{items:[{taskName:'Old task',catLabel:'Cleaning',base:100,qty:1}]},bookingSubmitting:false,localStorage:{setItem(){}},document:{getElementById:id=>nodes[id]||null,querySelector:()=>null} };
 vm.createContext(context);vm.runInContext(fs.readFileSync('js/booking-cart.js','utf8'),context);
 return {context,nodes};
}
test('remove cross removes only the selected task and keeps customer form fields',()=>{
 const {context:c,nodes:n}=setup();
 assert.match(c.bookingCartMarkup(c.quote.items),/aria-label="Remove Old task"/);
 c.removeBookingCartItem(0);
 assert.equal(c.quote.items.length,0);assert.equal(c.quote.low,0);assert.equal(n.confirmFreeBooking.disabled,true);
 assert.equal(n.fName.value,'Sammy');assert.equal(n.fPhone.value,'0400000000');assert.equal(n.fAddress.value,'Saved address');
 assert.match(n.bookingCart.outerHTML,/Your cart is empty/);
});
test('adding a task uses rate and minimum price without changing customer details',()=>{
 const {context:c,nodes:n}=setup();
 n.bookingCartTask={value:'0'};n.bookingCartQty={value:'2'};
 vm.runInContext("bookingCartCatalogue = [{category:{label:'Gardening',icon:'G'},task:{name:'Mow',rate:20,minJobPrice:75,unit:'hours'}}]",c);
 c.addBookingCartItem();assert.equal(c.quote.items.length,2);assert.equal(c.quote.items[1].base,75);assert.equal(c.quote.low,175);
 assert.equal(n.fAddress.value,'Saved address');
 c.bookingSubmitting=true;c.removeBookingCartItem(0);assert.equal(c.quote.items.length,2);
});
test('cart actions and edit control have no redirect to the estimator',()=>{
 const html=fs.readFileSync('mysubbies-booking.html','utf8');
 const edit=html.slice(html.indexOf('  function editPendingJob()'),html.indexOf('  function removePendingJob()'));
 assert.doesNotMatch(edit,/location\.href|rebook_request/);
 assert.match(html,/js\/booking-cart\.js/);
});
