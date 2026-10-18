const $ = id => document.getElementById(id);
let report, selected = 'duplicates', stage = 'after';
const labels = { duplicatesIgnored: 'Duplicate events ignored', blocksWrittenOnRerun: 'Blocks written on rerun',
  checkpointBeforeRestart: 'Persisted checkpoint', resumedFrom: 'Restart resumed at', blocksRecovered: 'Blocks recovered',
  commonAncestor: 'Common ancestor', orphanBlocksRetained: 'Orphan blocks retained', replacementBlocks: 'Replacement blocks replayed' };
function text(id, value) { $(id).textContent = String(value); }
function units(token) {
  const raw = BigInt(token.amountRaw), scale = 10n ** BigInt(token.decimals);
  const fraction = (raw % scale).toString().padStart(token.decimals, '0').slice(0, 3);
  return `${(raw / scale).toLocaleString('en-US')}${token.decimals ? '.' + fraction : ''} ${token.symbol}`;
}
function render() {
  if (!report) return;
  const scenario = report.scenarios.find(item => item.id === selected), snapshot = scenario[stage];
  const passes = snapshot.checks.filter(check => check.passed).length;
  text('metric-blocks', snapshot.canonicalBlocks);
  text('metric-events', snapshot.canonicalEvents);
  text('metric-checkpoint', snapshot.checkpoint);
  text('metric-checks', `${passes}/${snapshot.checks.length}`);
  text('metric-coverage', snapshot.missingBlocks ? `${snapshot.missingBlocks} blocks awaiting recovery` : '100% source range covered');
  text('metric-health', snapshot.healthy ? 'All invariants verified' : 'Recovery required');
  text('scenario-title', scenario.title); text('scenario-description', scenario.description);
  document.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.scenario === selected)));
  document.querySelectorAll('[data-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stage === stage)));
  $('scenario-panel').setAttribute('aria-labelledby', `tab-${selected}`);
  $('block-timeline').replaceChildren(...snapshot.timeline.map(block => {
    const cell = document.createElement('div'); cell.className = 'block' + (block.present ? '' : ' absent');
    cell.append(String(block.height)); const detail = document.createElement('span');
    detail.textContent = block.present ? `${block.events} events` : 'missing'; cell.append(detail); return cell;
  }));
  text('coverage-note', snapshot.mismatchedBlocks ? `${snapshot.mismatchedBlocks} stored blocks disagree with the source branch. Coverage alone does not establish correctness.`
    : snapshot.missingBlocks ? 'Incomplete coverage is reported as unhealthy; the checkpoint never skips a failed batch.'
    : 'Every block is accounted for, including empty block 105.');
  text('quality-badge', snapshot.healthy ? 'VERIFIED' : 'NEEDS RECOVERY'); $('quality-badge').className = 'status-badge' + (snapshot.healthy ? '' : ' bad');
  $('check-rows').replaceChildren(...snapshot.checks.map(check => {
    const row = document.createElement('tr'), name = document.createElement('td'), status = document.createElement('td');
    name.textContent = check.name; status.textContent = check.passed ? '✓ PASS' : '× FAIL'; status.className = check.passed ? 'pass' : 'fail';
    row.append(name, status); return row;
  }));
  const evidence = [['Snapshot', stage === 'after' ? 'After recovery' : 'Before recovery'],
    ['Duplicates ignored', snapshot.duplicatesIgnored], ['Orphan blocks (excluded)', snapshot.orphanBlocks],
    ['Source fingerprint', snapshot.fingerprintsMatch ? 'MATCH' : 'MISMATCH'],
    ...Object.entries(scenario.evidence).filter(([key]) => key !== 'duplicatesIgnored').map(([key, value]) => [labels[key], value])];
  $('evidence-list').replaceChildren(...evidence.flatMap(([key, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key; dd.textContent = value; return [dt, dd];
  }));
  text('volume-total', snapshot.tokenTotals.map(units).join(' · '));
}

document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => { selected = button.dataset.scenario; render(); }));
document.querySelectorAll('[data-stage]').forEach(button => button.addEventListener('click', () => { stage = button.dataset.stage; render(); }));
document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const buttons = [...document.querySelectorAll('[data-scenario]')];
  let index = buttons.findIndex(button => button.dataset.scenario === selected);
  index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault(); buttons[index].focus(); buttons[index].click();
});
try {
  const response = await fetch('./quality-report.json', { cache: 'no-cache', credentials: 'omit' });
  if (!response.ok) throw new Error('Report unavailable');
  const value = await response.json();
  if (value.schemaVersion !== 1 || value.dataset?.kind !== 'synthetic' || value.scenarios?.length !== 3 ||
    !value.scenarios.every(scenario => scenario.after?.checks?.length === 8 && scenario.before && ['duplicates','gap','reorg'].includes(scenario.id))) throw new Error('Invalid report');
  report = value;
  text('overall-status', report.healthy ? 'All recovery scenarios verified' : 'Recovery verification failed');
  text('overall-detail', '3 scenarios · 24 final checks · SQLite');
  if (!report.healthy) document.querySelector('.verification-icon').textContent = '×';
  render();
} catch {
  $('load-error').hidden = false;
  text('overall-status', 'Evidence unavailable'); text('overall-detail', 'Verification could not be displayed');
  document.querySelector('.verification-icon').textContent = '!';
}
