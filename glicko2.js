// Glicko-2 rating system (Mark Glickman), applied after every game the way
// Lichess does. http://www.glicko.net/glicko/glicko2.pdf

const SCALE = 173.7178;
const TAU = 0.5; // how fast volatility can change
const MIN_RD = 45; // keeps ratings responsive for regular players
const MAX_RD = 350;
const MIN_RATING = 400;

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

// player/opponent: { rating, rd, vol }; score: 1 win, 0.5 draw, 0 loss.
// Returns the player's new { rating, rd, vol }.
function update(player, opponent, score) {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const muJ = (opponent.rating - 1500) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const E = expected(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * E * (1 - E));
  const delta = v * gJ * (score - E);

  // New volatility via the Illinois algorithm (step 5 of the paper).
  const a = Math.log(player.vol * player.vol);
  const f = (x) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gJ * (score - E);

  return {
    rating: Math.max(MIN_RATING, muNew * SCALE + 1500),
    rd: Math.min(MAX_RD, Math.max(MIN_RD, phiNew * SCALE)),
    vol,
  };
}

// Ratings with high uncertainty are shown with a "?" until they settle.
const isProvisional = (rd) => rd > 110;

module.exports = { update, isProvisional };
