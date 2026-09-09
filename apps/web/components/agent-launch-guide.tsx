import Link from 'next/link';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

export function AgentLaunchGuide() {
  return (
    <Collapsible className="agent-launch-guide">
      <CollapsibleTrigger className="agent-launch-guide-toggle">
        <span className="agent-launch-guide-arrow" aria-hidden="true">▸</span>
        AGENT LAUNCH:
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="agent-launch-guide-heading">
          <span>Deploy on Long with your agent</span>
          <Link className="agent-launch-guide-link" href="/agent-guide.md" prefetch={false} target="_blank" rel="noreferrer">Quick guide ↗</Link>
        </div>
        <p>
          Ask: “Read <Link href="/llms.txt" prefetch={false} target="_blank" rel="noreferrer">farmgun.fun/llms.txt</Link>, then deploy Quorvix on Long / ETH.
          {' '}Try QVXL, QVX in order and use my image.”
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
