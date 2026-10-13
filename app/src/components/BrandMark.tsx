import iconUrl from "../../app-icon.svg";
import styles from "./BrandMark.module.css";

/** The app icon beside the app name in the header. Decorative; the name itself is the label. */
export function BrandMark() {
  return <img className={styles.mark} src={iconUrl} alt="" aria-hidden="true" />;
}
