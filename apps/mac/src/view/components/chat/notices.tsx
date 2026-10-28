import { Button } from '../ui/button';

/** A line above the composer that says what stands in the way, with the one action that helps, as the phone's. */
export function Notice({ message, tone = 'error', action, onAction }: {
  message: string; tone?: 'error' | 'neutral'; action?: string; onAction?: () => void;
}) {
  return (
    <p className={tone === 'error' ? 'notice notice-error' : 'notice'}>
      {message}
      {action && <Button type="button" variant="link" size="xs" className="notice-action" onClick={onAction}>
        {action}
      </Button>}
    </p>
  );
}
