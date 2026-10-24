/** Deployed addresses (deployments/testnet.json and deployments/mainnet.json). All verified on MonadScan. */
const NETWORKS = [
  {
    name: 'Monad Testnet',
    note: 'chain 10143',
    scan: 'https://testnet.monadscan.com/address',
    contracts: [
      ['CardBattle', '0x68B4759FaA160907327a6eB40dAe0A4094A90242'],
      ['BattleStakeVault', '0xF33d88f0D06bf16EA254f0067c272Fa328125E9e'],
      ['NadCards', '0x7AF33CB3823Ff99D37411A678452A7980d14CF9F'],
      ['BlitzArena', '0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9'],
      ['StakeVault', '0x642C1364b62344128087549ceeD9268D5E3385df'],
    ],
  },
  {
    name: 'Monad Mainnet',
    note: 'chain 143',
    scan: 'https://monadscan.com/address',
    contracts: [
      ['CardBattle', '0x1407a7463ec8dEAA57C55Df634f4C150AE93d26f'],
      ['BattleStakeVault', '0x4D13C24b27E36B4338f42C43878C981A92f768f4'],
      ['NadCards', '0x9ED90215833c4ADE8C72132AC079bc9e5d5A30A8'],
      ['BlitzArena', '0xdd56839940F5E20a4543e82ab01F43991C445E9A'],
      ['StakeVault', '0x2B740d932dD20B73230ff4cbfCF8F25b4Fe18933'],
    ],
  },
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Contracts() {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6 md:pt-8" aria-labelledby="contracts">
      <div className="flex flex-col gap-1">
        <h2 id="contracts" className="title">
          Contracts
        </h2>
        <p className="body text-ink-muted">Open source and verified on MonadScan. Tap an address to read the code.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {NETWORKS.map((net) => (
          <div key={net.name} className="flex flex-col rounded-card border border-line bg-surface-raised p-4">
            <div className="flex items-baseline justify-between gap-2 pb-2">
              <h3 className="title">{net.name}</h3>
              <span className="data text-ink-muted">{net.note}</span>
            </div>
            <ul className="flex flex-col">
              {net.contracts.map(([name, addr]) => (
                <li key={addr} className="flex items-center justify-between gap-3 border-t border-line py-2">
                  <span className="body">{name}</span>
                  <a
                    href={`${net.scan}/${addr}#code`}
                    target="_blank"
                    rel="noreferrer"
                    className="data text-purple-ink underline underline-offset-4"
                    title={addr}
                  >
                    {short(addr)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
