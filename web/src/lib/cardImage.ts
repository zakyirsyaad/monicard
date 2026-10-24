/** Mock mode has no card renderer: every card uses the placeholder. Real mode lets CardImage build the server URL. */
export const CARD_IMAGE_SRC: string | undefined =
  import.meta.env.VITE_USE_MOCK === '1' ? '/mock/card.svg' : undefined;
