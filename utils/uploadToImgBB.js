const axios = require("axios");
const FormData = require("form-data");

const uploadToImgBB = async (base64) => {
  try {
    const form = new FormData();
    form.append("image", base64);

    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      form,
      { headers: form.getHeaders() }
    );

    return response.data.data.url;
  } catch (err) {
    console.error("IMGBB ERROR:", err.response?.data || err);
    throw new Error("Image upload failed");
  }
};

module.exports = { uploadToImgBB };
