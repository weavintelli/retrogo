import { useState } from "preact/hooks";

type CounterProps = {
  clicked: string;
  times: string;
};

// The home template renders the same localized button for the no-JS response.
// This component replaces that node once home.js loads, retaining its copy.
export function Counter({ clicked, times }: CounterProps) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" className="btn btn-primary" onClick={() => setCount(count + 1)}>
      <span className="icon-[lucide--mouse-pointer-click]" /> {clicked} <span>{count}</span> {times}
    </button>
  );
}
