# pump.fun sniper

Automatický obchodní bot pro pump.fun: sleduje nové launche, filtruje je, nakupuje
z tvojí peněženky a sám prodává na take-profit / stop-loss. Součástí je lokální
webový dashboard.

---

## Než začneš čteš tohle

**Tohle je záporné EV, dokud nemáš rychlou infrastrukturu a dobré filtry.**
Konkrétně:

- Na veřejném RPC uvidíš nový token o **1–3 sekundy později** než profesionální
  boti s Geyser gRPC. V praxi tedy nakupuješ *od* skutečných sniperů, ne před nimi.
  Public endpointy tě navíc rate-limitují (ověřeno při vývoji).
- Drtivá většina launchů na pump.fun jsou rug pully.
- Počítej s tím, že o vložené peníze přijdeš. Vlož jen tolik, kolik jsi ochotný
  ztratit.

Pokud to chceš myslet vážně, největší jednotlivé zlepšení je placené RPC
(Helius, Triton, Shyft) s Geyser gRPC a odesílání přes Jito bundle.

## Peněženka — důležité

Bot musí podepisovat transakce sám, takže potřebuje privátní klíč. Phantom neumí
auto-approve.

**Nikdy sem nedávej klíč od své hlavní peněženky.**

1. V Phantomu si vytvoř **novou peněženku** (Add account).
2. Pošli na ni jen částku, o kterou můžeš přijít.
3. Settings → Export Private Key, zkopíruj do `.env`.

`.env` je v `.gitignore` a musí tam zůstat. Hlavní peněženku bot nikdy neuvidí —
když se cokoliv pokazí, přijdeš maximálně o obsah burneru.

## Instalace

```bash
cd sniper
npm install
cp .env.example .env
# vyplň PRIVATE_KEY
```

## Ověření, že instrukce sedí

```bash
npm run verify
```

Sestaví reálnou buy i sell transakci proti živému tokenu a nechá je **nasimulovat**
— nic se nepodepisuje ani neodesílá. Spusť to po každém `git pull`: pump.fun svůj
program mění a případný rozjezd layoutu se projeví právě tady.

## Spuštění

```bash
npm start
```

Dashboard běží na `http://localhost:8787`.

Bot startuje **odzbrojený**. Sniping začne až po stisku **ARM**. `PANIC SELL`
okamžitě odzbrojí bota a prodá všechny otevřené pozice.

## Otevření na telefonu

Dashboard je responzivní, ale bot musí běžet na počítači — telefon je jen okno
do něj přes Wi-Fi. Ve výchozím stavu poslouchá **jen na localhost**, protože
nemá žádné přihlášení a kdokoliv na stejné síti by mohl zapnout bota nebo ti
odprodat pozice.

Vpustit ho do sítě znamená nastavit token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Vlož ho do `.env` jako `DASHBOARD_TOKEN=` a bota restartuj. Při startu vypíše
hotovou adresu i s tokenem. Na telefonu (na stejné Wi-Fi) otevři tutéž adresu,
jen `localhost` nahraď lokální IP počítače:

```
http://192.168.1.42:8787/?token=<tvůj-token>
```

IP zjistíš přes `ip addr` (Linux), `ipconfig` (Windows) nebo `ifconfig | grep inet`
(macOS). Token se uloží do prohlížeče, takže ho zadáváš jen jednou.

Dvě věci k tomu:

- Bez tokenu se bot **odmítne** vystavit do sítě, a token kratší než 16 znaků
  nespustí vůbec.
- Je to HTTP na lokální síti, ne HTTPS. Na domácí Wi-Fi v pohodě —
  **neprostrkávej to port forwardingem na veřejný internet.** Když k tomu
  potřebuješ přístup zvenku, použij VPN nebo Tailscale.

## Dry run vs. živé obchodování

Ve výchozím stavu je `DRY_RUN=true` — bot všechno detekuje, vyhodnotí a loguje,
co by koupil, ale neodešle jedinou transakci. Doporučuju nechat ho tak běžet
aspoň den a podívat se, jestli by tvoje nastavení vůbec vydělávalo.

Živé obchodování zapneš `DRY_RUN=false` v `.env`. Schválně to **nejde** přepnout
z dashboardu — je to změna, která má vyžadovat vědomý zásah.

## Nasazení na VPS (a ovládání z iPhonu)

Bot **nejde spustit na telefonu** — iOS uspí procesy na pozadí, takže by přestal
hlídat stop-loss ve chvíli, kdy přepneš aplikaci. Telefon může být jen okno do
bota, který běží jinde.

Zároveň je VPS správné místo i pro bota obecně: notebook uspíš a otevřené pozice
zůstanou bez dozoru.

Na čistém Debianu nebo Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/lajdiss/mobil/claude/plzen-dating-app-wu5ryb/sniper/deploy/setup.sh | sudo bash
```

Skript nainstaluje Node, stáhne repo, vygeneruje `DASHBOARD_TOKEN`, založí
systemd službu (bot se sám nahodí po restartu serveru) a zavře port ve firewallu.
Bota **nespustí** — chybí mu klíč k peněžence.

Zbytek vypíše na konci: doplnit `PRIVATE_KEY` do `.env`, spustit `npm run verify`
a pak `systemctl start sniper`.

Port dashboardu zůstává zavřený schválně: přes veřejný internet by token šel po
drátě v čitelné podobě. Cesta dovnitř je privátní síť:

```bash
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up
sudo ufw allow in on tailscale0 to any port 8787
```

Pak stačí Tailscale z App Storu, přihlásit se stejným účtem a v Safari otevřít
`http://<tailscale-ip>:8787/?token=<token>`. Celé nastavení VPS se dá odklikat
z iPhonu — server koupíš v prohlížeči a připojíš se přes SSH klienta
(např. Termius).

## Úspěšnost

Dashboard počítá z uzavřených pozic úspěšnost a staví ji proti hranici, kterou
při daném TP/SL potřebuješ jen na to, abys byl na nule:

```
potřebná úspěšnost = (SL + poplatky) / (TP + SL)
```

Při TP 50 %, SL 30 % a ~2 % poplatcích to vychází na **40 %**. Číslo se
přepočítává podle toho, co máš zrovna nastavené, takže hned vidíš, jestli si
úpravou TP/SL pomáháš, nebo ne.

Panel drží jazyk za zuby, dokud nemá aspoň 20 uzavřených obchodů — pod tím
je jakékoliv procento jen šum.

Bot nic nepredikuje. Nemá názor na to, který token poroste; kupuje, co projde
filtry, a mechanicky uřízne pozici podle pravidel. Úspěšnost je tedy vlastnost
tvého nastavení a tržních podmínek, ne inteligence bota.

## Náklady

**Fixní, měsíčně:**

| Položka | Cena |
|---|---|
| VPS (Hetzner/Contabo, nejmenší) | 100–150 Kč |
| Tailscale (osobní použití) | zdarma |
| Veřejné RPC | zdarma, ale pomalé a rate-limitované |
| **Minimum celkem** | **~120 Kč** |

Placené RPC s Geyser gRPC — jediná věc, která ze snipování dělá něco
konkurenceschopného — stojí řádově tisíce korun měsíčně a bývá až ve vyšších
tarifech. Ceny si ověř aktuálně, mění se.

**Za obchod (v SOL):**

| Položka | Kolik |
|---|---|
| pump.fun poplatek | ~1 % z objemu při nákupu i prodeji |
| Priority fee | 0,000125 SOL při výchozím nastavení (0,00025 za round trip) |
| Podpis transakce | 0,000005 SOL |
| Rent token accountu | 0,00186–0,00196 SOL — **vratné** |

Ten rent je zrádný: každý sniplý token zamkne skoro 0,002 SOL. Při deseti
snipech denně je to 0,6 SOL měsíčně, což je násobně víc než server. Bot proto
po prodeji účet zavírá a nájem si bere zpět — v samostatné transakci, aby
neúspěšné zavření nemohlo shodit prodej.

**Reálně ale platí tohle:** při 0,01 SOL na obchod a 300 obchodech měsíčně
zaplatíš na poplatcích zhruba 0,15 SOL. Ztráty z propadlých rugů budou
řádově vyšší než všechny tyhle položky dohromady. Server je nejmenší
starost.

## Jak to funguje

| Fáze | Kde | Co se děje |
|---|---|---|
| Detekce | `detector.ts` | `logsSubscribe` na pump.fun program; při `Instruction: Create` se dotáhne transakce a z inner instrukce se dekóduje `CreateEvent` |
| Filtr | `filters.ts` | mayhem mode, sérioví createři, blacklist názvů |
| Nákup | `executor.ts` | sestaví `buy`, **nejdřív nasimuluje**, pak teprve odešle |
| TP/SL | `positions.ts` | `accountSubscribe` na bonding curve → přepočet PnL → automatický prodej |

TP/SL hlídá backend, ne prohlížeč — funguje i po zavření dashboardu.

## Nastavení

Vše v `.env` (viz `.env.example`). Za pozornost stojí:

| Proměnná | Význam |
|---|---|
| `DRY_RUN` | `true` = nic se neodesílá |
| `BUY_AMOUNT_SOL` | kolik SOL za jeden nákup |
| `MAX_SOL_PER_TRADE` | tvrdý strop, který dashboard nepřekročí |
| `DAILY_SPEND_CAP_SOL` | denní limit útraty |
| `MIN_SOL_RESERVE` | pod tento zůstatek bot nenakupuje |
| `TAKE_PROFIT_PCT` / `STOP_LOSS_PCT` | výstupní podmínky |
| `TRAILING_STOP_PCT` | `0` = vypnuto |
| `MAX_HOLD_SECONDS` | časový výstup bez ohledu na PnL |
| `MAX_CREATOR_LAUNCHES_PER_HOUR` | ochrana proti sériovým ruggerům |

Take profit, stop loss a velikost pozice jdou měnit za běhu v dashboardu.

## Poznámky k implementaci

Publikovaný Anchor IDL pump.fun je **pozadu za nasazeným programem**. Instrukce
v tomhle repu jsou postavené podle toho, co program skutečně vyžaduje, ověřeno
simulací proti mainnetu:

- `buy` potřebuje **18 účtů**, ne 16 jako v IDL. Chybějící dva jsou
  `bonding_curve_v2` (PDA `["bonding-curve-v2", mint]`, v IDL vůbec není) a
  `buyback_fee_recipient`. Bez nich program vrátí `BuybackFeeRecipientMissing`
  (6062), resp. `InvalidBondingCurveV2` (6074).
- `sell` potřebuje 16 účtů a má oproti `buy` prohozený `creator_vault`
  a `token_program`.
- Data instrukce mají 24 bajtů — koncový `track_volume` se neposílá.
- Fee recipient se rotuje a část položek v `Global` je zastaralá; volba se
  při `NotAuthorized` (6000) automaticky zkusí znovu s dalším kandidátem.
- Nové tokeny běží na **Token-2022**, ne na klasickém SPL Tokenu — token program
  se proto čte z `CreateEvent`, nehardcoduje se.

## Co bot nedělá

Neposílá transakce přes Jito bundle, nepoužívá Geyser gRPC a nedetekuje bundlované
dev nákupy. To jsou tři největší věci, které by ho posunuly z „hračky" na něco
konkurenceschopného.
