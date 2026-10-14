import { synced } from '../os/synced'
import { setCalcHomeCurrency } from '../os/smartcalc'

// The home currency, Settings → Language & region: the big number when you click an amount in an
// Agents reply (src/os/MoneyAmount.tsx), and what Spotlight's calculator converts money to when
// no target is named. Kept in this browser; synced when signed in, like the other settings.

export const HOME_CURRENCIES: [string, string][] = [
  ['EUR', 'Euro'],
  ['USD', 'US dollar'],
  ['GBP', 'Pound sterling'],
  ['JPY', 'Japanese yen'],
  ['CHF', 'Swiss franc'],
  ['CAD', 'Canadian dollar'],
  ['AUD', 'Australian dollar'],
  ['NZD', 'New Zealand dollar'],
  ['SEK', 'Swedish krona'],
  ['NOK', 'Norwegian krone'],
  ['DKK', 'Danish krone'],
  ['PLN', 'Polish złoty'],
  ['CZK', 'Czech koruna'],
  ['HUF', 'Hungarian forint'],
  ['CNY', 'Chinese yuan'],
  ['HKD', 'Hong Kong dollar'],
  ['SGD', 'Singapore dollar'],
  ['KRW', 'South Korean won'],
  ['TWD', 'New Taiwan dollar'],
  ['INR', 'Indian rupee'],
  ['THB', 'Thai baht'],
  ['IDR', 'Indonesian rupiah'],
  ['BRL', 'Brazilian real'],
  ['MXN', 'Mexican peso'],
  ['ZAR', 'South African rand'],
  ['TRY', 'Turkish lira'],
  ['ILS', 'Israeli shekel'],
  ['AED', 'UAE dirham'],
]

const store = synced<string>('homeCurrency', 'EUR', {
  normalize: (v) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : 'EUR'),
})

export const useHomeCurrency = store.use
export const homeCurrency = store.get
export const setHomeCurrency = (code: string) => store.set(code)

/** Hands the choice to the calculator and keeps it there as it changes. Called once at startup. */
export function initHomeCurrency() {
  const apply = () => setCalcHomeCurrency(store.get())
  apply()
  store.subscribe(apply)
}
