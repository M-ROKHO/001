/**
 * Wrapper function to catch async errors in route handlers
 * Eliminates the need for try-catch blocks in every async route
 * 
 * Usage:
 * router.get('/users', catchAsync(async (req, res, next) => {
 *   const users = await User.findAll();
 *   res.json(users);
 * }));
 */
const catchAsync = (fn) => {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
};

export default catchAsync;
