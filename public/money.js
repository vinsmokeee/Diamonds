// Shared "Nu. 1,250" formatter.
window.formatMoney = (amount, symbol = 'Nu.') =>
  `${symbol} ${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
