'use strict';

var { UserModel } = require('../../schema/api')
var { UserBusiness } = require('../../businesses')
var { S3, GM, Mailer, Uploader } = require('../../components')
var { UserValidator, parseJoiError } = require('../../validators')
var Helper = require('../../helpers')
var config = require('../../config/environment')
var jwt = require('jsonwebtoken')
var async = require('async')
var _ = require('lodash')

function validationError(res, statusCode) {
  statusCode = statusCode || 422;
  return function(err) {
    res.status(statusCode).json(err);
  }
}

function handleError(res, statusCode) {
  statusCode = statusCode || 500;
  return function(err) {
    res.status(statusCode).send(err);
  };
}


class UserController {
  /**
   * Get list of users
   */
  static index(req, res) {
    if(req.query.limit!='undefined'){
			req.query.limit = parseInt(req.query.limit);
		}
		if(req.query.offset!='undefined'){
			req.query.offset = parseInt(req.query.offset);
		}
    return UserBusiness.find(req.query)
      .then(users => {
        res.status(200).json(users);
      })
      .catch(handleError(res));
  }

  /**
   * Forgot password
   */
  static forgot(req, res) {
    var newPass = Math.floor(Math.random() * 1000000000);
    async.auto({
      user(cb) {
        UserModel.findOne({
          email: req.body.email
        }, cb);
      }
    }, function(err, result) {
      if (err) {
        return res.status(400).send(err);
      }

      if (!result.user && !result.performer) {
        return res.status(400).send({
          message: 'No account'
        });
      }

      var name, email;
      if (result.user) {
        UserBusiness.forgotPassword({email:req.body.email}, newPass);
        email = result.user.email;
        name = result.user.name;
      } 

      var send = {
        template: 'forgotPassword.html',
        to: email,
        subject: 'Forgot password ',
        user: {
          password: newPass,
          name: name
        }
      }
      Mailer.sendMail(send.template, send.to, Object.assign({subject: send.subject}, send), (err) => { });
      res.json({
        ok: true
      });
    });
  }

  /**
   * Creates a new user
   */
  static create(req, res, next) {
    UserValidator.validateCreating(req.body).then(user => {
      user.imageType = config.imageType;
      user.name = req.body.name;
      user.email = req.body.email;
      user.phone = req.body.phone;
      user.status = req.body.status;
      if (req.user && req.user.role === 'admin') {
        user.role = req.body.role;
        user.isVip = req.body.isVip;
      }
      user.dateExpire = req.body.dateExpire;
      user.emailVerifiedToken = Helper.StringHelper.randomString(48);
      async.waterfall([
        function(cb) {
          if (!req.files.file) {
            return  cb();
          }

          user.imageType = config.imageType;
          let Func = config.imageType == 's3' ? Uploader.uploadImageWithThumbnailsToS3 : Uploader.uploadImageWithThumbnails;
          Func(req.files.file, req.user._id, function(err, result) {
            user.photo  = result.imageFullPath;
            user.imageMediumPath  = result.imageMediumPath;
            user.imageThumbPath  = result.imageThumbPath;
            cb();
          });
        }
      ], function() {
        UserBusiness.create(user)
          .then((data) => {
            Mailer.sendMail('verify-email.html', data.email,
            {
              subject: 'Verify email address',
              user: data.toObject(),
              emailVerifyLink: config.baseUrl + `api/v1/users/verifyEmail/${data.emailVerifiedToken}`,
              siteName: config.siteName
            });
            res.status(200).json(data)
          })
          .catch(err => res.status(400).json(err));
      });
    })
    .catch(err => res.status(400).json(err));
  }

  static verifyEmail(req, res, next) {
    if (!req.params.token) {
      return res.status(404).send({
        message: 'Error verify token'
      })
    }
    UserModel.findOne({
      emailVerifiedToken: req.params.token
    }, function(error, user) {
      if (error) {
        return res.status(500).send(error)
      }
      if (!user) {
        return res.status(404).send({
          message: 'User not found'
        })
      }
      if (user.emailVerified) {
        return res.redirect(config.baseUrl)
      }
      user.emailVerified = true;
      user.emailVerifiedToken = null;
      user.save().then((data) => {
        res.redirect(config.baseUrl + 'login')
      })
    })
  };

  /**
   * Get a single user
   */
  static show(req, res, next) {
    UserBusiness.findOne({_id: req.params.id})
    .then(user => {
      if (!user) {
        return res.status(404).end();
      }
      res.json(user);
    })
    .catch(err => next(err));
  }

  /**
   * Deletes a user
   * restriction: 'admin'
   */
  static destroy(req, res) {
    UserBusiness.findOne({_id: req.params.id})
    .then(user => {
     UserTempBusiness.findOne({email: user.email}).then(userTemp => {
       if(userTemp){
         UserTempBusiness.removeById(userTemp._id).then(function(res){

         })
       }
        return UserBusiness.removeById(req.params.id)
            .then(function() {
              res.status(200,true).end();
            }).catch(handleError(res));
     });
    })
    .catch(err => next(err));
  }

  /**
   * Check User Expire Date
   */
  static checkVip(req, res, nex){
    var date = new Date();
    UserBusiness.find({"dateExpire": {"$lt": date}}).then(users => {
      for(var i =0; i < users.length; i++){
        users[i].isVip = false;
        users[i].isBuyProduct = false;
        users[i].save();
      }
    });
  }

  /**
   * Update Member Ship When purchased
   */
  static updateMemberShip(req, res, next) {
    //TODO - update validator
    var userId = req.body.userId || req.body['X-userId'];
    var type = req.body.type || req.body['X-type'];
    var packageId = req.body.packageId || req.body['X-packageId'];
    var subscriptionId = req.body.subscription_id || req.body['X-packageId'];

    //RenewalSuccess
    //if cannot renew, expire vip access for the user
    if (['Cancellation', 'RenewalFailure', 'NewSaleFailure'].indexOf(req.query.eventType) > -1) {
      return res.status(200).send({
        ok: true
      });
    } else if (['NewSaleSuccess', 'RenewalSuccess'].indexOf(req.query.eventType) > -1) {
      //do update for user subscription hook from CCBill
      return doCCBillCallhook(req, res);
    } else if (!req.query.eventType) {
      return res.status(200).send({
        ok: true
      });
    }

  }

  /**
   * Update Member Ship When purchased
   */
  static payment(req, res, next) {
    //TODO - update validator
    var userId = req.body.userId;
    var type = req.body.type;
    var productString = req.body.product;
    if (type === 'performer_subscription' && req.body.performerId) {
      UserSubscriptionModel.updateUserSubscription({
        userId: req.body.userId,
        performerId: req.body.performerId,
        subscriptionType: req.body.subscriptionType
      }, function(err) {
        res.status(err ? 500 : 200).send();
      });
      //TODO - creae transaction here
    } else if (productString) {
      var productArr = productString.split(',');
      async.waterfall([
        function(callback) {
          if(req.body.couponCode) {
            CouponModel.findOne({ code: req.body.couponCode, isActive: true }, function(err, coupon) {
              if (err || !coupon) {
                return callback(null);
              }

              if (coupon.useMultipleTimes) {
                callback(null, coupon);
              } else {
                OrderModel.find({'coupon.code': coupon.code}, function(err, data) {
                  if(err || data.length){
                    return callback(null);
                  }

                  callback(null, coupon);
                });
              }
            });
          } else {
            callback(null);
          }
        },
        function (coupon, callback) {
          if (coupon) {
            CouponModel.update({_id:coupon._id},{ $inc: { used: 1 }}, function(err, update){});
          }

          async.forEach(productArr, function (item, callback) {
            //console.log(item);
            var productItem = item.split("-");
            var productId = productItem[0];
            ProductBusiness.findOne({_id: productId})
              .then(function(product) {
                //console.log(product)
                if (!product) {
                  return callback('No product');
                }

                UserBusiness.findOne({_id: userId}).then(function(user) {
                  var quantity = productItem[1];
                  product.quantity = product.quantity - parseInt(quantity);
                  ProductBusiness.update(product)
                  var order = {
                    user: user._id,
                    description: product.name,
                    type: 'Store',
                    quantity: quantity,
                    price: product.price,
                    totalPrice: product.price * parseInt(quantity),
                    name:req.body.customer_fname + ' '+ req.body.customer_lname,
                    address:req.body.address1,
                    email:req.body.email,
                    phone:req.body.phone_number,
                    paymentInformation: req.body,
                    status: 'active'
                  };
                  if (coupon) {
                    order.coupon = coupon;
                  }

                  OrderBusiness.create(order,user).then(function(data) {
                    var send = {
                      template: 'buy_product.html',
                      to: user.email,
                      subject: config.siteName + ' - Payment successfully',
                      user: user,
                      product:product
                    }
                    Mailer.sendMail(send.template, send.to, Object.assign({subject: send.subject}, send), function (err) {});

                    callback();
                 }).catch(err => callback(err));
                }).catch(err => callback(err));
              }).catch(err => callback(err));
          }, function(err) {
            callback(err);
          });
        }
      ], function(err, result) {
        if (err) {
          return res.status(400).send(err);
        }

        res.status(200).send({ ok: true });
      });
    } else {
      res.status(400).send({ ok: false });
    }
  }
  /**
   * Change a users password
   */

  static changePassword(req, res) {
    if (!req.body.password) {
      return res.status(400).end();
    }

    req.user.password = req.body.password;
    req.user.save(err => res.status(200).send());
  }

  /**
   * Update Profile User
   */
  static updateProfile(req, res, next) {
    //TODO - update validator
    var userId = req.user._id;

    _.merge(req.user, _.pick(req.body.user, [
      'username','name', 'email', 'phone', 'photo', 'age',
      'bust', 'description', 'ethnicity', 'eyes', 'hair',
      'height', 'hometown', 'languages', 'publicHair',
      'sex', 'weight', 'subscriptionMonthlyPrice', 'subscriptionYearlyPrice',
      'idImg1', 'bankDateofBirth', 'bankFirstName', 'bankLastName', 'bankLegalType', 'bankBusinessTaxId',
      'bankBusinessTitle', 'bankCountry', 'bankSsn', 'bankState', 'bankCity', 'bankAddress', 'bankZip', 'bankName',
      'bankAccount', 'bankRounding', 'bankSwiftCode', 'bankBankAddress', 'welcomePhoto', 'welcomeVideo', 'welcomeOption',
      'showHome', 'ccbill', 'allowIds', 'autoPostTwitter', 'customTwitterTextVideo',
      'payoutType', 'paypalAccount', 'taxpayer', 'payoutCurrency'
    ]));
    req.user.save((err, user) => res.status(200).json(user));
  }

   /**
   * Update Profile User
   */
  static update(req, res, next) {
    //TODO - update validator
    var userId = req.body._id;
    UserBusiness.findOneByAdmin({_id: userId})
      .then(user => {
        if (!user) {
          return res.status(404).send();
        }

        user.name = req.body.name;
        user.email = req.body.email;
        user.phone = req.body.phone;
        user.status = req.body.status;

        if(req.body.password!='' && typeof req.body.password !='undefined'){
          user.password = req.body.password;
        }
        user.isVip = req.body.isVip;
        user.isBuyProduct = req.body.isBuyProduct;
        user.role = req.body.role;
        user.dateExpire = req.body.dateExpire;
        user.emailVerified = req.body.emailVerified;
        async.waterfall([
          function(cb) {
            if (!req.files.file) {
              return  cb();
            }

            user.imageType = config.imageType;
            let Func = config.imageType == 's3' ? Uploader.uploadImageWithThumbnailsToS3 : Uploader.uploadImageWithThumbnails;
            Func(req.files.file, req.user._id, function(err, result) {
              user.photo  = result.imageFullPath;
              user.imageMediumPath  = result.imageMediumPath;
              user.imageThumbPath  = result.imageThumbPath;
              cb();
            });
          }
        ], function() {
          UserBusiness.update(user)
            .then(() => res.status(200).json(user))
            .catch(err => validationError(res, 422)(parseJoiError(err)));
        });
    });
  }

  /**
   * Update Photo User
   */
  static updatePhoto(req, res, next) {
    var userId = req.user._id;
    UserBusiness.findOne({_id: userId})
      .then(user => {
        if (!user) {
          return res.status(404).send();
        }

        async.waterfall([
          function(cb) {
            if (!req.files.file) {
              return  cb();
            }

            user.imageType = config.imageType;
            let Func = config.imageType == 's3' ? Uploader.uploadImageWithThumbnailsToS3 : Uploader.uploadImageWithThumbnails;
            Func(req.files.file, req.user._id, function(err, result) {
              user.photo  = result.imageFullPath;
              user.imageMediumPath  = result.imageMediumPath;
              user.imageThumbPath  = result.imageThumbPath;
              cb();
            });
          }
        ], function() {
          UserBusiness.update(user)
            .then(() => res.status(200).json(user))
            .catch(err => validationError(res, 422)(parseJoiError(err)));
        });
      });
  }

  /**
   *  History download Video
   */
   static downloadVideo(req, res, next) {
      UserBusiness.findOne({_id: req.user._id}).then(user => {
        if(!user) {
          return validationError(res, 404)({message: 'Not found'});
        }
        if(user.downloadedVideo.length > 0){
          var exist = false;
          for(var i = 0 ; i < user.downloadedVideo.length ; i++){
            if(user.downloadedVideo[i]._id == req.body.video._id){
              exist = true;
            }
          }
        }
        if(!exist){
          user.downloadedVideo.push(req.body.video);
        }else{
          //return res.status(400).json({error:"You've added this video earlier."});
        }
        UserBusiness.update(user).then(function(user) {
            return res.status(200).json(user);
          })
          .catch(err => {
            validationError(res, 500)(err);
          });
        })
        .catch(err => {
         validationError(res, 422)(parseJoiError(err));
        });
  }

  /**
   * Add favorite Video
   */
   static favoriteVideo(req, res, next) {
      UserBusiness.findOne({_id: req.user._id}).then(user => {
        if(!user) {
          return validationError(res, 404)({message: 'Not found'});
        }
        if(user.favoriteVideo.length > 0){
          var exist = false;
          for(var i = 0 ; i < user.favoriteVideo.length ; i++){
            if(user.favoriteVideo[i] == req.body.video._id){
              exist = true;
            }
          }
        }
        if(!exist){
          user.favoriteVideo.push(req.body.video._id);
        }else{
          return res.status(400).json({error:"You've added this video earlier."});
        }
        UserBusiness.update(user).then(function(user) {
            return res.status(200).json(user);
          })
          .catch(err => {
            validationError(res, 500)(err);
          });
        })
        .catch(err => {
         validationError(res, 422)(parseJoiError(err));
        });
  }

  /**
   * Remove favorite Video
   */
   static removeFavoriteVideo(req, res, next) {
      UserBusiness.findOne({_id: req.user._id}).then(user => {
        if(!user) {
          return validationError(res, 404)({message: 'Not found'});
        }
        user.favoriteVideo = req.body.user.favoriteVideo;
        UserBusiness.update(user).then(function(user) {
            return res.status(200).json(user);
          })
          .catch(err => {
            validationError(res, 500)(err);
          });
        })
        .catch(err => {
         validationError(res, 422)(parseJoiError(err));
        });
  }

  /**
   * Add watch later Video
   */
   static watchLaterVideo(req, res, next) {
      UserBusiness.findOne({_id: req.user._id}).then(user => {
        if(!user) {
          return validationError(res, 404)({message: 'Not found'});
        }
        if(user.watchLaterVideo.length > 0){
          var exist = false;
          for(var i = 0 ; i < user.watchLaterVideo.length ; i++){
            if(user.watchLaterVideo[i]._id == req.body.video._id){
              exist = true;
            }
          }
        }
        if(!exist){
          user.watchLaterVideo.push(req.body.video);
        }else{
          return res.status(400).json({error:"You've added this video earlier."});
        }
        UserBusiness.update(user).then(function(user) {
            return res.status(200).json(user);
          })
          .catch(err => {
            validationError(res, 500)(err);
          });
        })
        .catch(err => {
         validationError(res, 422)(parseJoiError(err));
        });
  }

  /**
   * Remove watch later Video
   */
   static removeWatchLaterVideo(req, res, next) {
      UserBusiness.findOne({_id: req.user._id}).then(user => {
        if(!user) {
          return validationError(res, 404)({message: 'Not found'});
        }
        user.watchLaterVideo = req.body.user.watchLaterVideo;
        UserBusiness.update(user).then(function(user) {
            return res.status(200).json(user);
          })
          .catch(err => {
            validationError(res, 500)(err);
          });
        })
        .catch(err => {
         validationError(res, 422)(parseJoiError(err));
        });
  }

  /**
   * Get my info
   */
  static me(req, res, next) {
    if (req.isPerformer) {
      var data = req.user.toJSON();
      return res.status(200).send(Object.assign(_.omit(data, [
        'password'
      ]), {
        isPerformer: true,
        role: 'performer',
        photo: req.user.imageThumbPath
      }));
    }

    res.status(200).send(req.user);
  }

  /**
   * Authentication callback
   */
  static authCallback(req, res, next) {
    res.redirect('/');
  }

  static stats(req, res) {
    //async.waterfall();
  }
}

module.exports = UserController;
