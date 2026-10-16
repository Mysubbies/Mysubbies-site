const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
for(const filename of ['index.html','mysubbies-website.html']) test(`${filename} New Job opens booking portal and has no Fix Something popup`,()=>{
 const html=fs.readFileSync(filename,'utf8');
 assert.match(html,/class="tab-item tab-fab" onclick="openBookingPortal\(\)"/);
 assert.doesNotMatch(html,/id="fsModalOverlay"|<h3>Fix Something<\/h3>|function openFixSomething/);
 const source=html.slice(html.indexOf('  function openBookingPortal()'),html.indexOf('  function closeFixSomething()'));
 const context={window:{location:{}}};vm.createContext(context);vm.runInContext(source,context);context.openBookingPortal();
 assert.equal(context.window.location.href,'/mysubbies-booking.html?new=1');
});
test('New Job starts with an empty usable cart or keeps the pending cart',()=>{
 const html=fs.readFileSync('mysubbies-booking.html','utf8');
 const source=html.slice(html.indexOf('  let quote = getPendingQuote();'),html.indexOf("  const app = document.getElementById('app');"));
 for(const pending of [null,{items:[{taskName:'Existing task'}]}]){
  const c={getPendingQuote:()=>pending,URLSearchParams,location:{search:'?new=1'}};vm.createContext(c);vm.runInContext(source+'\nthis.result=quote;',c);
  assert.ok(Array.isArray(c.result.items));assert.equal(c.result.items.length,pending?1:0);
 }
 assert.match(html,/quote.items.length === 0\) openBookingCartAdd\(\)/);
 const portal=fs.readFileSync('mysubbies-customer-portal.html','utf8');
 const trigger=portal.slice(portal.indexOf('  function triggerFixSomething()'),portal.indexOf('  function bookMaintenanceTask('));
 assert.match(trigger,/stashPropertyForNewJob\(\)/);assert.match(trigger,/mysubbies-booking.html\?new=1/);
});
