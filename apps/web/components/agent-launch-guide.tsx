import Link from 'next/link';

export function AgentLaunchGuide() {
  return (
    <section className="agent-launch-guide" aria-labelledby="agent-launch-heading">
      <div className="agent-launch-guide-heading">
        <h2 id="agent-launch-heading">AGENT LAUNCH:</h2>
        <span>Deploy on Long with your agent</span>
        <Link className="agent-launch-guide-link" href="/agent-guide.md" prefetch={false} target="_blank" rel="noreferrer">Quick guide ↗</Link>
      </div>
      <p>
        Ask: “Read <Link href="/llms.txt" prefetch={false} target="_blank" rel="noreferrer">farmgun.fun/llms.txt</Link>, then deploy Quorvix on Long / ETH.
        {' '}Try QVXL, QVX in order and use my image.”
      </p>
    </section>
  );
}
