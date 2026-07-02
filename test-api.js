async function main() {
  try {
    const res = await fetch('http://localhost:3001/api/attendance?page=1&limit=10', {
      headers: {
        // We probably need authorization? Let's see if it works without or if it throws 403.
      }
    });
    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Data:", JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error:", e.message);
  }
}

main();
