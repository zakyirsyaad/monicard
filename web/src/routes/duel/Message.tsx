import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';

export interface MessageProps {
  text: string;
  /** Shows "Back to Play" under the text. */
  back?: boolean;
}

/** Loading, missing duel and spectator states: one line of text, optionally a way back. */
export function Message({ text, back = false }: MessageProps) {
  const navigate = useNavigate();
  return (
    <Screen>
      <div className="flex flex-1 flex-col justify-center gap-6 text-center">
        <p className="title text-ink" role="status">
          {text}
        </p>
        {back && (
          <Button variant="secondary" onClick={() => navigate('/play')}>
            Back to Play
          </Button>
        )}
      </div>
    </Screen>
  );
}
