// viewmodel.js - everything the game screen needs, worked out from the controller, the board being
// shown and the UI flags. Pure (no DOM), so the pass-and-play rules can be tested in Node:
//
//   * a lone human's hand is always on show;
//   * with two or more humans a hand is on show ONLY while it is that human's own decision, after
//     they confirmed the cover, and never while a replay of what just happened is on screen;
//   * the cards a human may play carry a reason when they may not, and a "would it win?" hint.
// Mooring has no hint beyond the button text (decisionHtml shows the cargo held and the ships there).

import { previewCard } from './preview.js';

/**
 * @param {object} p
 * @param {object} p.ctl     the controller
 * @param {object} p.ui      UI flags: { frame, modal, selected, note, panels }
 * @param {object} p.board   the board to draw (a playback frame's, or the live one)
 * @param {object[]} p.log   log entries
 */
export function makeVm({ ctl, ui, board, log }) {
  const st = ctl.state;
  const isLive = !ui.frame;
  const humans = ctl.humanSeats;
  const revealed = ctl.shownSeat();
  let handSeat = null;
  if (humans.length === 1) handSeat = humans[0];
  else if (humans.length > 1 && isLive && !ui.modal && ctl.isHumanTurn() && revealed === st.toAct) handSeat = st.toAct;
  const me = handSeat !== null ? handSeat : (revealed !== null ? revealed : (humans[0] !== undefined ? humans[0] : 0));
  const view = isLive && handSeat !== null ? ctl.view(handSeat) : null;
  const myTurn = !!view && st.toAct === handSeat && st.phase !== 'over' && !ui.modal;
  let hand = null;
  if (handSeat !== null) hand = isLive ? view.hand : (board.hands[handSeat] || []);
  const reasons = new Map();
  const hints = new Map();
  if (myTurn && st.phase === 'play') {
    for (const c of hand) {
      const r = ctl.blockReason(c, handSeat);
      reasons.set(c, r);
      if (!r) hints.set(c, previewCard(st, c));
    }
  }
  return {
    state: st, board, frame: ui.frame || null, names: ctl.names, types: ctl.seats.map((s) => s.type), humanSeats: humans,
    me, shown: handSeat, hand, view, reasons, hints, myTurn, ui, log,
  };
}
