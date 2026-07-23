import type { ReadStream, WriteStream } from 'node:tty';
import { validateOwnerPassword } from './owner-service.js';

async function readPasswordFromStdin(input: NodeJS.ReadStream): Promise<string> {
  let value = '';

  for await (const chunk of input) {
    value += chunk.toString();
    if (value.length > 1024) {
      throw new Error('Password input is too long');
    }
  }

  const password = value.replace(/\r?\n$/, '');
  if (password.includes('\n') || password.includes('\r')) {
    throw new Error('--password-stdin accepts exactly one line');
  }

  return validateOwnerPassword(password);
}

function readHiddenLine(prompt: string, input: ReadStream, output: WriteStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    };

    const finish = () => {
      cleanup();
      output.write('\n');
      resolve(value);
    };

    const fail = (error: Error) => {
      cleanup();
      output.write('\n');
      reject(error);
    };

    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          fail(new Error('Password entry cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          output.write('*');
        }
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

export async function readOwnerPassword(
  passwordStdin: boolean,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  if (passwordStdin) {
    return readPasswordFromStdin(input);
  }

  if (!input.isTTY || !output.isTTY || !('setRawMode' in input)) {
    throw new Error('Non-interactive password input requires --password-stdin');
  }

  const password = validateOwnerPassword(
    await readHiddenLine('Password: ', input as ReadStream, output as WriteStream),
  );
  const confirmation = await readHiddenLine(
    'Confirm password: ',
    input as ReadStream,
    output as WriteStream,
  );
  if (password !== confirmation) {
    throw new Error('Password confirmation does not match');
  }

  return password;
}
