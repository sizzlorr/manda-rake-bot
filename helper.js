function readableDate(isoDate) {
    return new Date(isoDate).toLocaleString("en-GB", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

module.exports = { readableDate };