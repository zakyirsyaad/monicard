import { Message } from './Message';

/** Someone who is not a participant opened a duel that already left Open. */
export function Spectator() {
  return <Message text="This duel is already underway." back />;
}
