import {
  Wallet, Banknote, Coins, CreditCard, PiggyBank, Currency,
  Building2, Home, KeyRound, Hotel,
  Car, Truck, Bike,
  Gem, CircleDollarSign, Layers,
  LineChart, CandlestickChart, Briefcase, TrendingUp,
  Plane, Palmtree, ShoppingBasket, UtensilsCrossed, HeartPulse, Fuel, Gift,
  GraduationCap, Smartphone, User, Wrench, Shirt, PawPrint, Ticket,
  HandHeart, HeartHandshake, HandCoins,
  ArrowDownToLine, ArrowUpFromLine, ArrowDown, ArrowRight, SendHorizontal, Percent,
  RefreshCw, ChevronLeft, Sun, Moon, Plus, Pencil, X, AlertTriangle, Bell,
  Clock, Check, Eye, EyeOff, BookOpen, Filter, Trash2, Search, Undo2, Handshake,
  Menu, Squircle, MessageSquare, Plug, Blocks, Lock, Palette, Repeat, Tag,
  CalendarDays, CalendarRange, Download,
  type LucideIcon,
} from 'lucide-react';
import { AnimIcon, ANIM_NAMES, type AnimName } from './AnimIcon';

/**
 * One library, one weight, one grid. The set is Lucide — drawing these by hand gave a
 * dozen slightly different personalities, and consistency is the whole job of an icon set.
 *
 * Two rules hold the set together, and both are about a mark meaning one thing:
 *
 * One subject, one mark. Gold is the same glyph on the sidebar, in the module list, on the
 * price sources and inside the money flow — it used to be a pyramid in one place and a
 * jewel in another, which reads as two different subjects to anyone who is not the person
 * who wrote it.
 *
 * A direction is not a subject. Where a control has two ways — buying or selling, money in
 * or money out, lent or borrowed — both sides are drawn from the same pair, `in` and `out`,
 * so the two halves are visibly one decision. Putting a subject's mark on one side and an
 * arrow on the other is what made buying a jewel and selling an arrow.
 *
 * The twelve names that AnimIcon draws are not in this table: they have exactly one
 * drawing, the animated one, so there is no library glyph sitting behind them waiting to
 * be picked up by mistake.
 */
const ART = {
  // subjects the set draws from the library; the other twelve live in AnimIcon
  charity: HeartHandshake, calendar: CalendarDays,
  // direction — one pair, wherever a movement has two ways
  in: ArrowDownToLine, out: ArrowUpFromLine,
  // chrome
  refresh: RefreshCw, chevron: ChevronLeft, sun: Sun, moon: Moon, plus: Plus,
  edit: Pencil, close: X, warn: AlertTriangle, bell: Bell, clock: Clock,
  check: Check, eye: Eye, eyeoff: EyeOff, ledger: BookOpen,
  filter: Filter, trash: Trash2, search: Search, undo: Undo2, handshake: Handshake, menu: Menu,
  // arrow points the way something travels: across a row, or down a stacked form.
  // `send` is the one that acts rather than points — it is the button, not the path.
  arrow: ArrowRight, arrowdown: ArrowDown, send: SendHorizontal,
  // the answer to a mark this set does not have: a shape that means nothing rather than
  // another subject's icon standing in and quietly claiming to be it
  unknown: Squircle,
  download: Download,
  // cash
  banknote: Banknote, wallet: Wallet, coins: Coins, card: CreditCard, savings: PiggyBank,
  currency: Currency, fees: Percent, price: Tag,
  // metal — a bar is a stack, a coin is minted, a ring is worn
  goldbar: Layers, goldcoin: CircleDollarSign, ring: Gem,
  // property
  house: Home, apartment: Building2, key: KeyRound, building: Hotel,
  // vehicles
  car: Car, suv: Truck, motorbike: Bike,
  // markets
  chartline: LineChart, candles: CandlestickChart, briefcase: Briefcase, salary: TrendingUp,
  // spending
  plane: Plane, beach: Palmtree, groceries: ShoppingBasket, restaurant: UtensilsCrossed,
  health: HeartPulse, fuel: Fuel, gift: Gift, education: GraduationCap,
  phone: Smartphone, person: User, tools: Wrench, shirt: Shirt, pet: PawPrint,
  ticket: Ticket, hands: HandHeart, handout: HandCoins,
  // settings, each tab drawn as what it is rather than as an action that happens to live
  // near it: prices was the refresh arrow, access was a house key, modules was the assets
  // crate, and each of those marks already belonged to something else
  chat: MessageSquare, plug: Plug, modules: Blocks, lock: Lock, appearance: Palette,
  repeat: Repeat, span: CalendarRange,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ART | AnimName;


/** Is this a mark this set can draw? Anything else is a name from somewhere else. */
export function hasIcon(name: string | undefined): name is IconName {
  return !!name && (name in ART || (ANIM_NAMES as string[]).includes(name));
}

/**
 * Icons move when the control holding them is hovered — and what moves is the icon's own
 * parts, never the icon.
 *
 * Sliding a whole glyph about is the cheap version of this and it reads as exactly that: the
 * picture jumps and means nothing by it. A bell should swing its clapper, a bin should lift
 * its lid, a car should turn its wheels. Where a glyph is drawn as several shapes those
 * shapes are animated one by one; where it is a single shape it breathes in place rather than
 * travelling, because there is nothing inside it to move.
 *
 * `motion` is kept for the few callers that want an icon to sit perfectly still — a mark in a
 * table, an icon inside something that is already animating.
 */
export type Motion = 'parts' | 'none';

export function Icon({ name, size = 17, color = 'currentColor', strokeWidth = 1.75, motion, style }: {
  name: IconName; size?: number; color?: string; strokeWidth?: number; motion?: Motion;
  style?: React.CSSProperties;
}) {
  // A handful of icons are drawn here rather than taken from the library, because their
  // animation decides their geometry.
  if ((ANIM_NAMES as string[]).includes(name)) {
    return <AnimIcon name={name as AnimName} size={size} color={color} strokeWidth={strokeWidth} />;
  }
  const Cmp = (ART as Record<string, LucideIcon>)[name] ?? ART.unknown;
  // The per-name class is what lets the stylesheet animate the icon's own parts — a bell's
  // clapper, an eye's pupil — and `ico-parts` is the fallback for the ones with no rule of
  // their own: their shapes stagger in place, and the glyph itself stays where it is.
  return (
    <Cmp size={size} color={color} strokeWidth={strokeWidth} aria-hidden="true" style={style}
         className={motion === 'none' ? `ico ico-${name}` : `ico ico-${name} ico-parts`} />
  );
}

/** Icons offered for a subject are icons OF that subject. */
export const ICON_FAMILY: Record<string, IconName[]> = {
  cash: ['banknote', 'wallet', 'coins', 'card', 'savings'],
  gold: ['goldbar', 'goldcoin', 'ring'],
  realestate: ['house', 'apartment', 'key', 'building'],
  car: ['car', 'suv', 'motorbike'],
  /* Everything the assets screen holds: a flat, a car, a machine, a thing. It offered the
     buildings alone, so a car could be named "Car" and marked only as a house. */
  assets: ['house', 'apartment', 'building', 'key',
           'car', 'suv', 'motorbike',
           'tools', 'briefcase', 'goldbar', 'assets'],
  stocks: ['chartline', 'candles', 'briefcase', 'salary'],
  spending: ['plane', 'beach', 'groceries', 'restaurant', 'health', 'fuel', 'gift',
             'education', 'phone', 'person', 'tools', 'shirt', 'pet', 'ticket', 'expenses'],
  income: ['income', 'salary', 'briefcase', 'person', 'gift'],
  giving: ['hands', 'charity', 'gift', 'person', 'health', 'education', 'groceries', 'building'],
};

export const VIEW_TONE: Record<string, { icon: IconName; color: string }> = {
  portfolio: { icon: 'portfolio', color: 'var(--ink)' },
  assistant: { icon: 'chat', color: 'var(--accent)' },
  debts: { icon: 'handshake', color: 'var(--car)' },
  dashboards: { icon: 'dashboards', color: 'var(--stocks)' },
  accounts: { icon: 'accounts', color: 'var(--cash)' },
  income: { icon: 'income', color: 'var(--positive)' },
  flow: { icon: 'flow', color: 'var(--car)' },
  realestate: { icon: 'assets', color: 'var(--negative)' },
  assets: { icon: 'assets', color: 'var(--car)' },
  gold: { icon: 'gold', color: 'var(--gold)' },
  stocks: { icon: 'stocks', color: 'var(--stocks)' },
  expenses: { icon: 'expenses', color: 'var(--gold)' },
  giving: { icon: 'zakat', color: 'var(--zakat)' },
  calendar: { icon: 'calendar', color: 'var(--zakat)' },
  settings: { icon: 'settings', color: 'var(--muted)' },
};
