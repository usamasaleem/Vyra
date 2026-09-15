/**
 * The customer asking to see the car.
 *
 * Photographs are normally sent once: someone asking three questions about the
 * same Huracán should not get the same picture three times, and repeating it is
 * what a bot does.
 *
 * That rule is right for an incidental mention and wrong the moment they ask.
 * Live, a customer said "Can you send me more images related to this car" and
 * then "show me side profile", and got prose both times — because the pictures
 * had already been sent once. Worse, the agent told them it could not send a
 * photograph at all, which had stopped being true an hour earlier.
 *
 * So an explicit request overrides the once-only rule, and shows the ones they
 * have not seen.
 */
const ASKS_TO_SEE: RegExp[] = [
  /\b(?:show|send|see|share)\b[^.?!]{0,30}\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b/i,
  /\b(?:photo|photos|picture|pictures|image|images|pic|pics)\b[^.?!]{0,20}\b(?:please|pls)\b/i,
  /\b(?:more|other|another|different)\b[^.?!]{0,15}\b(?:photo|photos|picture|pictures|image|images|pic|pics|angle|angles|view|views|shot|shots)\b/i,
  /\bcan (?:i|we) see\b/i,
  /\bwhat does it look like\b/i,
  /\b(?:show|see)\b[^.?!]{0,25}\b(?:side|front|rear|back|inside|interior|cabin|profile)\b/i,
]

export function asksToSeePhotos(text: string | null): boolean {
  if (text === null || text.trim() === '') return false
  return ASKS_TO_SEE.some((p) => p.test(text))
}
