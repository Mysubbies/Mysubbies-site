const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
for(const filename of ['index.html','mysubbies-website.html']) test(`${filename} New Job opens booking portal and has no Fix Something popup`,()=>{
 const html=fs.readFileSync(filename,'utf8');
 assert.match(html,/class="tab-item tab-fab" onclick="openBookingPortal\(\)"/);
 assert.doesNotMatch(html,/id="fsModalOverlay"|<h3>Fix Something<\/h3>|function openFixSomething/);
 const source=html.slice(html.indexOf('  function openBookingPortal()'),html.indexOf('  function closeFixSomething()'));
 let step, scrolled=false; const context={showEstStep:n=>step=n,document:{getElementById:()=>({scrollIntoView(){scrolled=true;}})}};vm.createContext(context);vm.runInContext(source,context);context.openBookingPortal();
 assert.equal(step,1); assert.equal(scrolled,true);
});
test('legacy new-job links redirect to the estimator and portal links preserve the property handoff',()=>{
 const html=fs.readFileSync('mysubbies-booking.html','utf8');
 assert.match(html,/location.replace\('\/#estimate'\)/);
 const portal=fs.readFileSync('mysubbies-customer-portal.html','utf8');
 const trigger=portal.slice(portal.indexOf('  function triggerFixSomething()'),portal.indexOf('  function bookMaintenanceTask('));
 assert.match(trigger,/stashPropertyForNewJob\(\)/);assert.match(trigger,/\/#estimate/);
});
