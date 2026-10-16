const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('node:vm');
function setup(){
 const nodes=Object.fromEntries(['bookingCartTask','bookingTaskChoice','bookingTaskQuantity','bookingAddTaskConfirm','bookingTaskSearch','bookingTaskCategory','bookingTaskResults','bookingCartQty'].map(id=>[id,{value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,focus(){},insertAdjacentHTML(_position,text){this.innerHTML+=text}}]));
 const c={quote:{items:[{taskName:'Lawn mowing — small',catLabel:'Gardening'}]},document:{getElementById:id=>nodes[id]}};vm.createContext(c);vm.runInContext(fs.readFileSync('js/booking-cart.js','utf8'),c);
 vm.runInContext("bookingCartPreferredCategory='Gardening';bookingCartCatalogue=[{category:{label:'Fencing'},task:{name:'Timber fence',rate:100,unit:'lm'}},{category:{label:'Gardening'},task:{name:'Lawn edging',rate:39,unit:'visit'}},{category:{label:'Gardening'},task:{name:'Lawn mowing — large',rate:300,unit:'visit'}}];",c);
 nodes.bookingTaskCategory.value='Gardening';return{c,nodes};
}
test('the picker begins with relevant extras, without selected-task variants or another trade',()=>{
 const {c,nodes:n}=setup();c.renderBookingTaskResults();assert.match(n.bookingTaskResults.innerHTML,/Lawn edging/);assert.doesNotMatch(n.bookingTaskResults.innerHTML,/Timber fence|Lawn mowing/);assert.equal(n.bookingAddTaskConfirm.disabled,true);
 c.chooseBookingTask(1);assert.equal(n.bookingCartTask.value,'1');assert.equal(n.bookingAddTaskConfirm.disabled,false);assert.match(n.bookingTaskChoice.textContent,/Lawn edging/);
});
test('search finds another trade and preserves explicit service filtering',()=>{
 const {c,nodes:n}=setup();n.bookingTaskSearch.value='timber';c.renderBookingTaskResults(true);assert.equal(n.bookingTaskCategory.value,'');assert.match(n.bookingTaskResults.innerHTML,/Timber fence/);
 n.bookingTaskCategory.value='Gardening';c.renderBookingTaskResults();assert.doesNotMatch(n.bookingTaskResults.innerHTML,/Timber fence/);assert.match(n.bookingTaskResults.innerHTML,/No matching/);
});
test('the estimator and checkout use the same job-card content with their own edit handlers',()=>{
 const {c}=setup();const item={taskName:'Clean',qty:1,base:99,unit:'job',notes:'Included work'};
 const first=c.bookingCartMarkup([item],{estimator:true}),second=c.bookingCartMarkup([item]);
 for(const html of [first,second]){assert.match(html,/booking-cart-item/);assert.match(html,/Job total/);assert.match(html,/Included work/);assert.match(html,/Due at booking/)}
 assert.match(first,/updateCartQuantity\(0/);assert.match(first,/estAddAnotherService/);assert.match(second,/updateBookingCartQuantity\(0/);
});
