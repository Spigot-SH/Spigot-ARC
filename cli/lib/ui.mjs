import readline from 'readline';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (useColor ? `[${code}m${s}[0m` : s);

export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');

export const ok = msg => console.log(`${green('✓')} ${msg}`);
export const warn = msg => console.log(`${yellow('!')} ${msg}`);
export const fail = msg => console.error(`${red('✗')} ${msg}`);
export const info = msg => console.log(`  ${dim(msg)}`);

export const ask = (question, { silent = false } = {}) =>
  new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (silent) {
      // Keep secrets off the screen while they are typed.
      const onData = char => {
        if (['\n', '\r', ''].includes(char.toString())) {
          process.stdin.pause();
          return;
        }
        // Redraw the prompt with everything typed so far masked.
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`${question}${'*'.repeat(rl.line.length)}`);
      };
      process.stdin.on('data', onData);
      rl.question(question, answer => {
        process.stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(answer.trim());
      });
      return;
    }

    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

export const table = (rows, columns) => {
  if (!rows.length) return;
  const widths = columns.map(c =>
    Math.max(c.header.length, ...rows.map(r => String(c.get(r) ?? '').length)),
  );
  console.log(dim(columns.map((c, i) => c.header.padEnd(widths[i])).join('  ')));
  for (const row of rows) {
    console.log(columns.map((c, i) => String(c.get(row) ?? '').padEnd(widths[i])).join('  '));
  }
};

/** Render a spinner while a promise settles, so long chain waits do not look frozen. */
export const withSpinner = async (label, promise) => {
  if (!process.stdout.isTTY) return promise;

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${label}`);
  }, 80);

  try {
    return await promise;
  } finally {
    clearInterval(timer);
    process.stdout.write(`\r${' '.repeat(label.length + 3)}\r`);
  }
};
