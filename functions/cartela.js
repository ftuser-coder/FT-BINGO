function getCard(cardNumber) {
  const seed = Number(cardNumber) || 1;
  let s = seed;
  const rnd = () => {
    const x = Math.sin(s++) * 10000;
    return x - Math.floor(x);
  };
  const getColumnNumbers = (start, end) => {
    const pool = [];
    for (let i = start; i <= end; i++) pool.push(i);
    const result = [];
    while (result.length < 5) {
      const idx = Math.floor(rnd() * pool.length);
      result.push(pool.splice(idx, 1));
    }
    return result.sort((a, b) => a - b);
  };
  const card = {
    B: getColumnNumbers(1, 15),
    I: getColumnNumbers(16, 30),
    N: getColumnNumbers(31, 45),
    G: getColumnNumbers(46, 60),
    O: getColumnNumbers(61, 75)
  };
  card.N = "FREE"; 
  return card;
}

function hasBingo(cardNumber, calledSet) {
  const card = getCard(cardNumber);
  const called = (val) => val === "FREE" || calledSet.has(Number(val));
  const columns = ["B", "I", "N", "G", "O"];
  
  for (let r = 0; r < 5; r++) {
    let rowWin = true;
    for (let c = 0; c < 5; c++) { if (!called(card[columns[c]][r])) { rowWin = false; break; } }
    if (rowWin) return true;
  }
  for (let c = 0; c < 5; c++) {
    if (card[columns[c]].every(called)) return true;
  }
  let d1 = true, d2 = true;
  for (let i = 0; i < 5; i++) {
    if (!called(card[columns[i]][i])) d1 = false;
    if (!called(card[columns[i]][4 - i])) d2 = false;
  }
  return d1 || d2;
}

module.exports = { getCard, hasBingo };
