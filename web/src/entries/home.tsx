import { render } from "preact";
import { Counter } from "../components/Counter";

const mount = document.getElementById("counter");
if (mount) render(<Counter />, mount);
