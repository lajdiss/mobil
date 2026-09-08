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

## Aktualizace na nejnovější verzi

Bot se pořád mění. Pokud už ho máš stažený:

```bash
cd mobil/sniper
git pull
npm install          # jen když se změnil package.json
npm run verify       # ověř, že instrukce pořád sedí
npm run verify:amm   # totéž pro AMM (graduované tokeny)
npm start
```

Pokud si nejsi jistý, že jsi na správné větvi:

```bash
git checkout claude/plzen-dating-app-wu5ryb
git pull
```

Kdyby `git pull` hlásil konflikt kvůli tvým vlastním úpravám, tohle zahodí
lokální změny a vezme čistou verzi z GitHubu (`.env` zůstane, je gitignorovaný):

```bash
git reset --hard origin/claude/plzen-dating-app-wu5ryb
```

Stahuješ poprvé:

```bash
git clone -b claude/plzen-dating-app-wu5ryb https://github.com/lajdiss/mobil.git
cd mobil/sniper
npm install
cp .env.example .env
```

## Ověření, že instrukce sedí

```bash
npm run verify
```

Sestaví reálnou buy i sell transakci proti živému tokenu a nechá je **nasimulovat**
— nic se nepodepisuje ani neodesílá. Spusť to po každém `git pull`: pump.fun svůj
program mění a případný rozjezd layoutu se projeví právě tady.

## Testy

```bash
npm run test:filters   # filtr propouští běžné launche a odmítá vadné
npm run test:exits     # scale-out a exit na prodeji tvůrce
```

`test:filters` existuje kvůli konkrétní chybě: filtr, který vypadal rozumně,
odmítal **57 ze 57 launchů** a bot prostě přestal obchodovat. Nic nespadlo, nic
nezalogovalo chybu — jediný příznak bylo počítadlo na nule. Test proto kontroluje
i to, že běžný launch **projde**, ne jen že vadný neprojde.

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

### Prokluz stop-lossu

Panel zvlášť měří, **o kolik pod nastavenou hranicí** prodej reálně skončil.
Rozlišuje dvě věci, které se snadno pletou:

- **Malý prokluz** = bot zareagoval pozdě. To je řešitelné rychlejší infrou.
- **Velký prokluz (přes 5 bodů)** = cena hranici *přeskočila*. Rug proběhne
  v jediné transakci, kdy křivka spadne z nuly rovnou na −60 %. Cena se přes
  −30 % nikdy neobchodovala, takže se tam nebylo čeho chytit.

Tohle rozlišení je důležité, protože druhý případ **žádným nastavením stop-lossu
nevyřešíš.** Když panel hlásí hodně gapů, problém není v konfiguraci — je v tom,
co kupuješ. Řešením jsou přísnější filtry nebo menší pozice, ne nižší stop-loss.

Bot nic nepredikuje. Nemá názor na to, který token poroste; kupuje, co projde
filtry, a mechanicky uřízne pozici podle pravidel. Úspěšnost je tedy vlastnost
tvého nastavení a tržních podmínek, ne inteligence bota.

### Co vyšlo z měření

Bot umí nahrávat cenové dráhy na disk a pak přes ně offline přehrát libovolné
výstupní pravidlo. Díky tomu se dá porovnávat na **identických obchodech**, ne na
dvou různých běžících instancích:

```bash
npm run replay -- data/paths.jsonl              # mřížka pravidel
npm run replay -- data/paths.jsonl --sort=wr    # seřazeno podle úspěšnosti
npm run replay -- data/paths.jsonl --latency    # cena zpoždění výstupu
npm run replay:split -- data/paths.jsonl        # drží to na druhé polovině dat?
npm run replay:entry -- data/launches.jsonl     # kdy nakoupit × jak vystoupit
npm run replay:regime -- data/launches.jsonl    # jde poznat dobré okno předem?
```

Tři věci, které z toho vyšly a stojí za to je znát, než si něco nastavíš:

**1. Výstupy jsou na stropě.** Když se každá nahraná dráha prodá v jejím vlastním
vrcholu — tedy s dokonalou předvídavostí — vyjde skoro stejná úspěšnost jako
u nejlepšího reálného pravidla. Z tokenu, který se nikdy neobchodoval nad
vstupem, nevyrobí výhru žádné TP/SL. Ladit výstupy tedy nemá smysl.

**2. Rozhoduje zpoždění výstupu, ne pravidlo.** Stejné dráhy, mění se jen okamžik,
kdy se prodej naceňuje:

| zpoždění | úspěšnost | expectancy | bez 3 nejlepších |
|---|---|---|---|
| 0 s | 43,9 % | +5,21 % | +3,89 % |
| 1 s | 38,9 % | +3,45 % | +1,98 % |
| 1,5 s | 36,7 % | +1,98 % | +0,62 % |
| 3 s | 31,1 % | −0,22 % | −1,61 % |
| 5 s | 28,3 % | −0,52 % | −1,57 % |

Zhruba **2 body expectancy a 4 body úspěšnosti za každou sekundu**. Celé to
překlápí do ztráty kolem dvou sekund. Na domácím PC přes veřejné RPC se pohybuješ
právě v té ztrátové části tabulky — proto je nahoře napsáno, že bez rychlé infry
je to záporné EV. Není to opatrnost, je to naměřené.

**3. Úspěšnost bývá vlastnost okna, ne strategie.** Rozdělení nahrávek na dvě
poloviny podle času dalo 9,3 % úspěšnosti v jedné a 53,5 % v druhé, a **žádné
pravidlo nedrželo v obou**. Když ti vyjde hezké číslo na malém vzorku, skoro
jistě jsi změřil trh, ne své nastavení.

### Čemu nevěřit

Sloupec `exp-3` je expectancy po odebrání tří nejlepších obchodů a `top3` říká,
kolik procent zisku ty tři nesou. Když je `top3` kolem 100 % nebo výš, "zisk"
dělá jeden šťastný token a při dalším běhu tam nebude.

Sloupec `need` (potřebná úspěšnost) se tiskne jako `n/a`, pokud méně než 70 %
výstupů skončí na TP nebo SL — vzorec totiž předpokládá, že skončí všechny.
Jakmile většina obchodů vyprší časem pár procent od vstupu, `need` nepopisuje nic.

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
| `ENTRY_MODE` | co bot vůbec kupuje (viz níže) |

Take profit, stop loss a velikost pozice jdou měnit za běhu v dashboardu.

### Režimy vstupu (`ENTRY_MODE`)

| Režim | Co dělá |
|---|---|
| `snipe` | kupuje na launchi. Závod o latenci, který veřejné RPC prohrává. |
| `delay` | kupuje ty samé launche o `DELAY_SECONDS` později, bez podmínek |
| `momentum` | čeká, až token na křivce nabere likviditu a kupující |
| `copy` | následuje peněženky s měřeným výsledkem |
| `consensus` | čeká, až ten samý token koupí několik ověřených peněženek naráz |
| `graduate` | ignoruje křivku a obchoduje AMM pool po graduaci |
| `trending` | vybírá **živé tokeny jakéhokoli stáří** podle toho, kolik různých peněženek je právě kupuje |

`trending` je nejnovější a jediný, který nestojí na launchi. Bere z pump.fun
seznam tokenů obchodovaných v posledních `TRENDING_MAX_TRADE_AGE_SECONDS`
a pozornost počítá z vlastního streamu — **kolik různých peněženek** kupuje, ne
kolik proběhlo obchodů. Dvacet nákupů od tří peněženek je jeden bot v kruhu;
dvacet od dvaceti je dav. Hlídá i `TRENDING_MAX_TOP_BUYER_SHARE`, aby se velryba
nespletla s davem.

Komentáře na pump.fun (callouty) se jako signál **nedají použít** — ze 295 živě
obchodovaných tokenů neměl ani jeden komentář za posledních 24 hodin a všechny
časy posledního komentáře byly ~7 měsíců staré. `reply_count` je historický
pozůstatek, ne známka zájmu.

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
