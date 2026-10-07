import fetch from "node-fetch";

const url = "http://localhost:3000/extract";
const options = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-RapidAPI-Key": "Sənin_RapidAPI_Key-in",
    "X-RapidAPI-Host": "Sənin_API_Host-un"
  },
  body: JSON.stringify({ url: "https://youtube.com/watch?v=abc123" })
};

fetch(url, options)
  .then(res => res.json())
  .then(json => console.log(json))
  .catch(err => console.error("Error:", err));