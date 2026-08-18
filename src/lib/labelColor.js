/**
 * A label's accent colour, derived from its emoji.
 *
 * This was originally sampled at runtime: draw the glyph to an OffscreenCanvas
 * and average its dominant hue. That was abandoned for two reasons.
 *
 * 1. Emoji artwork clusters. Sampling put ⚡ 🪐 🏆 💰 👑 🥇 inside a 4° band of
 *    gold, 📈 💎 🌊 inside 2° of blue, and 🐳 🤖 inside 2° of cyan — because a
 *    trophy and a gold medal really are the same colour. Two labels sharing a
 *    colour carry no information, which is the entire point of having one.
 * 2. It read whichever emoji font the OS ships, so the same label came out a
 *    different colour on macOS than on Windows.
 *
 * So the mapping is a hand-tuned table instead: one colour per picker emoji,
 * each still plausible for its glyph, spread around the hue wheel so no two sit
 * close together. Where a family genuinely can't be split by hue — the golds —
 * they're separated by saturation and lightness instead: a vivid yellow ⚡
 * against a muted tan 🪐 against a bronze 🏆.
 *
 * Entries are ordered by hue so the wheel is visible when editing: adding an
 * emoji means finding its arc and checking it isn't crowding a neighbour.
 * Lightness stays in the 48–70% band so every colour holds up both as a 3px
 * stripe and as chip text on the near-black surface.
 */

/**
 * Anything not in the table — notably emoji retired from the picker. Kept
 * deliberately dim: an unrecognised emoji has no colour to stand for, and the
 * lightness gap is what separates it from 🤖, the one real colour that is also
 * grey.
 */
const NEUTRAL = '#7E848C';

const COLORS = {
  '🌶️': '#E8474F', // 356°  red
  '🚀': '#FF4438', // 5°    red-orange
  '🔥': '#FF6B2C', // 18°   orange
  '🏆': '#C98A2E', // 34°   bronze
  '🥇': '#E8AC1F', // 40°   gold
  '✨': '#FFF0A0', // 50°   pale cream — lightness is what separates it from 🥇
  '🍀': '#A8D62B', // 75°   yellow-green
  '📈': '#71CC3A', // 95°   green
  '💰': '#2FBF52', // 140°  money green
  '🧪': '#2ED9A0', // 165°  teal-green
  '🐳': '#2FC4CE', // 185°  cyan
  '💎': '#5CCBF5', // 197°  light blue
  '🌊': '#2E96E0', // 205°  ocean blue
  '👑': '#9B7CFA', // 253°  royal violet
  '🔮': '#B45FF0', // 283°  purple — deeper than 👑, which sits lighter at 253°
  '🧠': '#E070D6', // 305°  orchid
  '🎯': '#FF7A96', // 348°  light red-pink

  // Off the wheel deliberately: the robot is the one glyph that is metallic
  // rather than coloured, so it gets brushed steel — cooled slightly toward
  // blue and kept bright, so it reads as a colour rather than as the dim
  // NEUTRAL above.
  '🤖': '#C6D6E8',
};

/**
 * Accent colour for a label.
 *
 * @param {string} emoji the label's emoji
 * @returns {string} `#rrggbb`; NEUTRAL for an emoji no longer in the picker
 */
export function colorForEmoji(emoji) {
  return COLORS[String(emoji || '')] || NEUTRAL;
}
