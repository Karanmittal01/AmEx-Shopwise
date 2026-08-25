import readline from 'node:readline';

/**
 * Ask a question on the terminal. With `hidden: true` the typed characters are
 * not echoed, so passphrases and card numbers stay out of the visible scrollback.
 */
export function ask(question, { hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(`Cannot prompt for "${question}" — not an interactive terminal.`));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (hidden) {
      const onData = (char) => {
        const s = String(char);
        if (s === '\n' || s === '\r' || s === '') {
          process.stdin.removeListener('data', onData);
        } else {
          // Repaint the prompt without the typed characters.
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question);
        }
      };
      process.stdin.on('data', onData);
    }

    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

export async function askRequired(question, opts) {
  for (;;) {
    const answer = await ask(question, opts);
    if (answer) return answer;
    console.log('  (required)');
  }
}

export async function confirm(question) {
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}
