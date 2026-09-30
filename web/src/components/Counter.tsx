import { useState } from "preact/hooks";

// The home template renders the same button for the no-JS response. This
// component replaces that node once home.js loads.
export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" className="btn btn-primary" onClick={() => setCount(count + 1)}>
      <span className="icon-[lucide--mouse-pointer-click]" /> Clicked <span>{count}</span> times
    </button>
  );
}
