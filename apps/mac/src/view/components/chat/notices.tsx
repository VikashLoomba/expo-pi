import { Alert, AlertAction, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';

/** What stands in the way, above the composer as the chatbot template's Alert, with the one action that helps. */
export function Notice({ message, tone = 'error', action, onAction }: {
  message: string; tone?: 'error' | 'neutral'; action?: string; onAction?: () => void;
}) {
  return (
    <Alert variant={tone === 'error' ? 'destructive' : 'default'}>
      <AlertDescription>{message}</AlertDescription>
      {action && (
        <AlertAction>
          <Button type="button" variant="link" size="xs" onClick={onAction}>{action}</Button>
        </AlertAction>
      )}
    </Alert>
  );
}
