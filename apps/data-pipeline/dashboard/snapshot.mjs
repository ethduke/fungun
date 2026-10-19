const $=id=>document.getElementById(id),text=(id,value)=>{$(id).textContent=String(value);};
const date=value=>new Date(value).toLocaleString('en-GB',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})+' UTC';
function amount(raw,decimals,symbol){const n=BigInt(raw),scale=10n**BigInt(decimals),fraction=(n%scale).toString().padStart(decimals,'0').slice(0,3);return `${(n/scale).toLocaleString('en-US')}${decimals?'.'+fraction:''} ${symbol}`;}
try{
  const response=await fetch('./snapshot-report.json',{credentials:'omit',cache:'no-cache'});if(!response.ok)throw new Error('Unavailable');
  const r=await response.json(),a=r.analysis;
  if(r.schemaVersion!==1||r.kind!=='chain-snapshot'||r.healthy!==true||!Array.isArray(a?.hours)||a.hours.length!==24||
    !r.checks?.length||!r.checks.every(c=>c.passed===true)||!(Date.parse(a.end)>Date.parse(a.start)&&Date.parse(a.end)-Date.parse(a.start)<=86400000)||r.session?.intervalMinutes!==15)throw new Error('Invalid snapshot');
  text('snapshot-status','Saved range verified');text('snapshot-scope',`${r.chain} · ${r.symbol} · ${r.session.status==='complete'?'24h complete':Math.floor(r.session.capturedSeconds/60)+' min captured / 24h target'}`);
  document.querySelector('.verification-icon').textContent='✓';
  text('snapshot-window',`${date(a.start)} → ${date(a.end)}`);
  text('snapshot-transfers',a.transfers.toLocaleString('en-US'));text('snapshot-transactions',`${a.transactions.toLocaleString('en-US')} transactions`);
  text('snapshot-total',amount(a.amountRaw,r.decimals,r.symbol));text('snapshot-addresses',a.activeAddresses.toLocaleString('en-US'));
  text('snapshot-check-count',`${r.checks.length}/${r.checks.length}`);text('snapshot-range',`${a.blocks.toLocaleString('en-US')} block heights in scope`);
  const max=Math.max(1,...a.hours.map(h=>h.transfers));
  $('hourly-chart').replaceChildren(...a.hours.map((hour,i)=>{const column=document.createElement('div'),bar=document.createElement('div'),label=document.createElement('span');
    column.className='hour-column';bar.className='hour-bar';if(!hour.observed)column.classList.add('unobserved');
    // Class-based height avoids inline styles under the page's restrictive CSP.
    bar.classList.add(`level-${Math.round(hour.transfers/max*20)}`);column.title=`${date(hour.start)}: ${hour.transfers} transfers`;
    label.textContent=i%4===0?new Date(hour.start).getUTCHours().toString().padStart(2,'0'):'';column.append(bar,label);return column;}));
  text('snapshot-peak',`Busiest hour: ${date(a.peakHour)} · ${Math.max(...a.hours.map(h=>h.transfers))} transfers`);
  $('hourly-rows').replaceChildren(...a.hours.map(h=>{const tr=document.createElement('tr');for(const value of [date(h.start),h.transfers,amount(h.amountRaw,r.decimals,r.symbol)]){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;}));
  $('snapshot-checks').replaceChildren(...r.checks.map(c=>{const tr=document.createElement('tr'),name=document.createElement('td'),status=document.createElement('td');name.textContent=c.name;status.textContent='✓ PASS';status.className='pass';tr.append(name,status);return tr;}));
  const details=[['Captured',date(a.capturedAt)],['Chain ID',r.chainId],['First block',a.startHeight],['Last block',a.endHeight],
    ['Median transfer',amount(a.medianRaw,r.decimals,r.symbol)],['Largest transfer',amount(a.largestRaw,r.decimals,r.symbol)],
    ['Public RPC',r.sources.join(' · ')],['Duplicates ignored',r.duplicatesIgnored],['Missing events recovered',r.missingEventsRecovered],['Failed checks retried',r.failedChecks],['Verified intervals',r.verifiedIntervals],['SQLite SHA-256',r.databaseSha256]];
  $('snapshot-details').replaceChildren(...details.flatMap(([name,value])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;return[dt,dd];}));
  text('snapshot-verification',r.verification);
}catch{$('snapshot-error').hidden=false;text('snapshot-status','Snapshot unavailable');text('snapshot-scope','Verification could not be displayed');document.querySelector('.verification-icon').textContent='!';}
