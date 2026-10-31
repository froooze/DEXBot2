const assert = require('assert');
const { walkCliArgs } = require('../market_adapter/cli_args');

console.log('Running cli_args walker tests');

type WalkHandlers = Parameters<typeof walkCliArgs>[1];

{
    // Value + no-value flags consume their tokens in order.
    const seen = { out: null as string | null, verbose: 0 };
    walkCliArgs(['--out', '/tmp/x.json', '--verbose'], {
        onHelp: () => { throw new Error('help should not fire'); },
        value: { '--out': (raw: string) => { seen.out = raw; } },
        flag: { '--verbose': () => { seen.verbose += 1; } },
    });
    assert.strictEqual(seen.out, '/tmp/x.json', 'value flag should receive the next token');
    assert.strictEqual(seen.verbose, 1, 'no-value flag should fire');
}

{
    // `--flag=value` form, including a value that starts with `--`.
    const seen: string[] = [];
    walkCliArgs(['--out=--odd.json', '--bot=AAA-BBB'], {
        onHelp: () => { throw new Error('help should not fire'); },
        value: { '--out': (raw: string) => seen.push(raw), '--bot': (raw: string) => seen.push(raw) },
    });
    assert.deepStrictEqual(seen, ['--odd.json', 'AAA-BBB'], 'inline value should not be treated as a flag');
}

{
    // A flag-shaped bare value is still rejected; the `=` form is the escape hatch.
    const handlers: WalkHandlers = {
        onHelp: () => { throw new Error('help should not fire'); },
        value: { '--out': () => { throw new Error('handler must not run'); } },
    };
    assert.throws(() => walkCliArgs(['--out', '--odd.json'], handlers), /Flag --out expects a value; got --odd\.json/);
    assert.throws(() => walkCliArgs(['--out'], handlers), /Flag --out expects a value; got nothing/);
}

{
    // No-value flags reject the `=` form instead of silently dropping the value.
    assert.throws(
        () => walkCliArgs(['--verbose=1'], {
            onHelp: () => { throw new Error('help should not fire'); },
            flag: { '--verbose': () => { throw new Error('handler must not run'); } },
        }),
        /Flag --verbose does not take a value/
    );
}

{
    // Unknown flags name the token as typed (including any inline value).
    assert.throws(
        () => walkCliArgs(['--nope=1'], { onHelp: () => { throw new Error('help should not fire'); } }),
        /Unknown argument: --nope=1/
    );
    assert.throws(
        () => walkCliArgs(['positional'], { onHelp: () => { throw new Error('help should not fire'); } }),
        /Unknown argument: positional/
    );
}

{
    // `--help` / `-h` delegate to the caller's exit policy.
    let help = 0;
    walkCliArgs(['--help'], { onHelp: () => { help += 1; } });
    walkCliArgs(['-h'], { onHelp: () => { help += 1; } });
    assert.strictEqual(help, 2, 'both help spellings should fire once');
    assert.throws(
        () => walkCliArgs(['--help=1'], { onHelp: () => { throw new Error('handler must not run'); } }),
        /Flag --help does not take a value/,
        'help must not silently drop an inline value either'
    );
}

{
    // The retired grid-reset flag keeps its dedicated guidance, in either spelling.
    assert.throws(
        () => walkCliArgs(['--gridResetFactor', '2'], { onHelp: () => { throw new Error('help should not fire'); } }),
        /--gridResetFactor is no longer supported; use --deltaPercent/
    );
    assert.throws(
        () => walkCliArgs(['--gridResetFactor=2'], { onHelp: () => { throw new Error('help should not fire'); } }),
        /--gridResetFactor is no longer supported; use --deltaPercent/
    );
}

console.log('cli_args walker tests passed');
